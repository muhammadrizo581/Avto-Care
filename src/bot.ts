import { Telegraf, Markup, Context } from 'telegraf';
import { message } from 'telegraf/filters';
import { InputMediaPhoto, InputMediaVideo } from 'telegraf/types';
import dotenv from 'dotenv';
import axios from 'axios';

import * as queries from './db/queries';
import * as keyboards from './keyboards/inline';
import { isAdmin, adminOnly } from './middlewares/auth';
import { AdminState } from './types';
import { analyzeImage, parseUserQuery } from './ai/analyzer';
import { recolorSeatCover } from './ai/imageGenerator';

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('❌ BOT_TOKEN .env faylda topilmadi!');

const bot = new Telegraf(BOT_TOKEN);

// ============================================================
// === HOLAT (STATE) ===
// ============================================================
const adminState = new Map<number, AdminState>();
const userMessages = new Map<number, number[]>();
const aiSearchState = new Map<number, number>();
const aiResultCache = new Map<number, { carId: number; results: number[] }>();

interface RecolorState {
    carId: number;
    imageBuffer?: Buffer;
    resultBuffer?: Buffer;
    detectedColor?: string;
}
const recolorState = new Map<number, RecolorState>();

// Aloqa qo'shish holati
const addContactState = new Map<number, { step: 'name' | 'username'; name?: string }>();

let isAnalyzing = false;
const ITEMS_PER_PAGE = 6;

// ============================================================
// === /start ===
// ============================================================
bot.start(async (ctx) => {
    const adminText = isAdmin(ctx.from.id) ? '\n\n👑 Siz adminsiz. /admin - admin panel' : '';
    await ctx.reply(
        `Salom, ${ctx.from.first_name}! 👋\n\nMen moshina chexollari botiman. 🚗\nMoshinangizni tanlang va mos chexollar rasmlarini ko'ring.${adminText}`,
        Markup.keyboard([['🚗 Moshinalar']]).resize()
    );
});

// ============================================================
// === /cancel — barcha jarayonlarni bekor qilish ===
// ============================================================
bot.command('cancel', async (ctx) => {
    aiSearchState.delete(ctx.from.id);
    recolorState.delete(ctx.from.id);
    addContactState.delete(ctx.from.id);
    await ctx.reply('❌ Bekor qilindi.');
});

// ============================================================
// === MOSHINALAR ===
// ============================================================
async function showCars(ctx: Context): Promise<void> {
    try {
        await deleteOldMessages(ctx);
        if (ctx.from) aiSearchState.delete(ctx.from.id);
        const cars = await queries.getAllCars();
        if (cars.length === 0) { await ctx.reply('Hozircha moshinalar qo\'shilmagan.'); return; }
        await ctx.reply('🚗 Moshinangizni tanlang:', keyboards.carsKeyboard(cars));
    } catch (err) { console.error('showCars error:', err); }
}

bot.hears('🚗 Moshinalar', showCars);
bot.command('cars', showCars);

bot.action(/^car:(\d+)$/, async (ctx) => {
    const carId = parseInt(ctx.match[1]);
    await ctx.answerCbQuery();
    await ctx.deleteMessage().catch(() => {});
    await showMediaPage(ctx, carId, 0);
});

bot.action(/^page:(\d+):(\d+)$/, async (ctx) => {
    const carId = parseInt(ctx.match[1]);
    const page = parseInt(ctx.match[2]);
    await ctx.answerCbQuery();
    await showMediaPage(ctx, carId, page);
});

bot.action('back_to_cars', async (ctx) => { await ctx.answerCbQuery(); await showCars(ctx); });
bot.action('noop', async (ctx) => { await ctx.answerCbQuery(); });

// ============================================================
// === MEDIA SAHIFALASH ===
// ============================================================
async function showMediaPage(ctx: Context, carId: number, page: number): Promise<void> {
    try {
        const car = await queries.getCarById(carId);
        if (!car) { await ctx.reply('❌ Moshina topilmadi.'); return; }

        const totalCount = await queries.getMediaCount(carId);
        if (totalCount === 0) { await ctx.reply(`📷 ${car.name} uchun rasmlar yo'q.`); return; }

        const totalPages = Math.ceil(totalCount / ITEMS_PER_PAGE);
        const offset = page * ITEMS_PER_PAGE;
        const mediaList = await queries.getMediaByCarId(carId, ITEMS_PER_PAGE, offset);

        await deleteOldMessages(ctx);

        const headerMsg = await ctx.reply(
            `🚗 ${car.name}\n📊 Jami: ${totalCount} ta\n📄 Sahifa: ${page + 1}/${totalPages}`
        );

        const mediaGroup: (InputMediaPhoto | InputMediaVideo)[] = mediaList.map((item: any, index: number) => ({
            type: item.file_type,
            media: item.file_id,
            caption: index === 0 && item.caption ? item.caption : undefined,
        }));

        const mediaMessages = await ctx.replyWithMediaGroup(mediaGroup);
        const navMsg = await ctx.reply('👇 Boshqaruv:', keyboards.paginationKeyboard(carId, page, totalPages));

        const userId = ctx.from!.id;
        userMessages.set(userId, [
            headerMsg.message_id,
            ...mediaMessages.map(m => m.message_id),
            navMsg.message_id,
        ]);
    } catch (err) { console.error('showMediaPage error:', err); }
}

async function deleteOldMessages(ctx: Context): Promise<void> {
    if (!ctx.from || !ctx.chat) return;
    const oldIds = userMessages.get(ctx.from.id);
    if (!oldIds?.length) return;
    await Promise.all(oldIds.map(id => ctx.telegram.deleteMessage(ctx.chat!.id, id).catch(() => {})));
    userMessages.delete(ctx.from.id);
}

// ============================================================
// === AI QIDIRUV ===
// ============================================================
bot.action(/^ai_search:(\d+)$/, async (ctx) => {
    const carId = parseInt(ctx.match[1]);
    aiSearchState.set(ctx.from!.id, carId);
    await ctx.answerCbQuery();
    await ctx.reply(
        '🔍 Tasvirlab qidirish (AI)\n\nQanday chexol qidiryapsiz? Erkin yozing:\n\n' +
        '💡 Misollar:\n• qizil charm sport\n• qora oddiy\n• ko\'k ekokharm\n\nBekor qilish: /cancel'
    );
});

bot.action(/^ai_page:(\d+):(\d+)$/, async (ctx) => {
    const carId = parseInt(ctx.match[1]);
    const page = parseInt(ctx.match[2]);
    await ctx.answerCbQuery();
    const session = aiResultCache.get(ctx.from!.id);
    if (!session || session.carId !== carId) {
        await ctx.reply('❌ Sessiya tugagan. Qaytadan qidiring.');
        return;
    }
    await showAiPage(ctx, session.results, carId, page);
});

async function showAiPage(ctx: Context, resultIds: number[], carId: number, page: number): Promise<void> {
    const totalPages = Math.ceil(resultIds.length / ITEMS_PER_PAGE);
    const pageIds = resultIds.slice(page * ITEMS_PER_PAGE, (page + 1) * ITEMS_PER_PAGE);
    await deleteOldMessages(ctx);

    const car = await queries.getCarById(carId);
    const newMessageIds: number[] = [];

    const headerMsg = await ctx.reply(
        `🎯 AI Qidiruv natijalari\n🚗 ${car?.name}\n📊 Topildi: ${resultIds.length} ta | Sahifa: ${page + 1}/${totalPages}`
    );
    newMessageIds.push(headerMsg.message_id);

    const mediaList = await queries.getMediaByIds(pageIds);

    if (mediaList.length > 0) {
        const mediaGroup: (InputMediaPhoto | InputMediaVideo)[] = mediaList.map((item: any, index: number) => ({
            type: item.file_type,
            media: item.file_id,
            caption: index === 0 && item.ai_description ? `💬 ${item.ai_description}` : undefined,
        }));
        const mediaMessages = await ctx.replyWithMediaGroup(mediaGroup);
        mediaMessages.forEach(m => newMessageIds.push(m.message_id));
    }

    const navMsg = await ctx.reply('👇 Boshqaruv:', keyboards.aiPaginationKeyboard(carId, page, totalPages));
    newMessageIds.push(navMsg.message_id);
    userMessages.set(ctx.from!.id, newMessageIds);
}

// ============================================================
// === ALOQAGA CHIQISH (FOYDALANUVCHI) ===
// ============================================================
bot.action('contact_admins', async (ctx) => {
    await ctx.answerCbQuery();
    const contacts = await queries.getAllContacts();

    if (contacts.length === 0) {
        await ctx.reply('😔 Hozircha aloqa uchun adminlar qo\'shilmagan.');
        return;
    }

    await ctx.reply(
        '📞 Aloqaga chiqish\n\nBittasini tanlang:',
        keyboards.contactsKeyboard(contacts)
    );
});

// ============================================================
// === ADMIN PANEL ===
// ============================================================
bot.command('admin', adminOnly, async (ctx) => {
    await ctx.reply(
        '👑 Admin panel\n\n' +
        '📋 Asosiy:\n' +
        '/addcar - Yangi moshina qo\'shish\n' +
        '/addmedia - Rasm/video qo\'shish\n' +
        '/listcars - Moshinalar ro\'yxati\n' +
        '/deletecar - Moshina o\'chirish\n\n' +
        '📞 Aloqalar:\n' +
        '/addcontact - Yangi aloqa qo\'shish\n' +
        '/listcontacts - Aloqalar ro\'yxati\n' +
        '/deletecontact - Aloqani o\'chirish\n\n' +
        '🎨 Rasm:\n' +
        '/recolor - Rang o\'zgartirish (AI)\n\n' +
        '🤖 AI:\n' +
        '/analyze - AI tahlil paneli\n' +
        '/aistats - AI statistikasi\n' +
        '/stop_analyze - Tahlilni to\'xtatish'
    );
});

// === Moshina qo'shish ===
bot.command('addcar', adminOnly, async (ctx) => {
    const carName = ctx.message.text.replace('/addcar', '').trim();
    if (!carName) { await ctx.reply('Misol: /addcar Cobalt'); return; }
    try {
        const car = await queries.createCar(carName);
        await ctx.reply(`✅ Moshina qo'shildi: ${car.name}`);
    } catch (err: any) {
        if (err.code === '23505') await ctx.reply('❌ Bu moshina allaqachon mavjud.');
        else { console.error('addcar error:', err); await ctx.reply('❌ Xatolik.'); }
    }
});

bot.command('addmedia', adminOnly, async (ctx) => {
    const cars = await queries.getAllCars();
    if (cars.length === 0) { await ctx.reply('Avval moshina qo\'shing: /addcar'); return; }
    await ctx.reply('📸 Qaysi moshinaga rasm/video qo\'shasiz?', keyboards.adminCarsKeyboard(cars));
});

bot.action(/^admin_add:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) {
        await ctx.answerCbQuery('⛔ Ruxsat yo\'q', { show_alert: true });
        return;
    }
    const carId = parseInt(ctx.match[1]);
    const car = await queries.getCarById(carId);
    if (!car) { await ctx.answerCbQuery('❌ Moshina topilmadi'); return; }
    adminState.set(ctx.from.id, { mode: 'add_media', carId });
    await ctx.answerCbQuery();
    await ctx.reply(`📸 ${car.name} uchun rasm yoki video yuboring.\nTugatganda /done yozing.`);
});

bot.action('admin_cancel', async (ctx) => {
    if (ctx.from) adminState.delete(ctx.from.id);
    await ctx.answerCbQuery('Bekor qilindi');
    await ctx.deleteMessage();
});

bot.command('done', adminOnly, async (ctx) => {
    if (adminState.get(ctx.from.id)) {
        adminState.delete(ctx.from.id);
        await ctx.reply('✅ Yakunlandi.');
    } else {
        await ctx.reply('Hech qanday faol jarayon yo\'q.');
    }
});

bot.command('listcars', adminOnly, async (ctx) => {
    const cars = await queries.getAllCars();
    if (cars.length === 0) { await ctx.reply('Moshinalar yo\'q.'); return; }
    let text = '📋 Moshinalar ro\'yxati:\n\n';
    for (const car of cars) {
        const count = await queries.getMediaCount(car.id);
        text += `🚗 ${car.name} (ID: ${car.id}) — ${count} ta media\n`;
    }
    await ctx.reply(text);
});

// ============================================================
// === MOSHINA O'CHIRISH ===
// ============================================================
bot.command('deletecar', adminOnly, async (ctx) => {
    const cars = await queries.getAllCars();
    if (cars.length === 0) { await ctx.reply('Moshinalar yo\'q.'); return; }
    await ctx.reply(
        '🗑️ Qaysi moshinani o\'chirmoqchisiz?\n\n⚠️ Moshina va uning barcha rasmlari o\'chadi!',
        keyboards.deleteCarsKeyboard(cars)
    );
});

bot.action(/^delete_car_confirm:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) {
        await ctx.answerCbQuery('⛔ Ruxsat yo\'q', { show_alert: true });
        return;
    }
    const carId = parseInt(ctx.match[1]);
    const car = await queries.getCarById(carId);
    if (!car) { await ctx.answerCbQuery('❌ Moshina topilmadi'); return; }
    const mediaCount = await queries.getMediaCount(carId);
    await ctx.answerCbQuery();
    await ctx.editMessageText(
        `⚠️ Tasdiqlang!\n\n🚗 ${car.name}\n📷 ${mediaCount} ta rasm\n\nBarchasi o'chiriladi. Davom etamizmi?`,
        keyboards.deleteCarConfirmKeyboard(carId)
    );
});

bot.action(/^delete_car_yes:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) {
        await ctx.answerCbQuery('⛔ Ruxsat yo\'q', { show_alert: true });
        return;
    }
    const carId = parseInt(ctx.match[1]);
    try {
        const car = await queries.getCarById(carId);
        const mediaCount = await queries.getMediaCount(carId);
        await queries.deleteCar(carId);
        await ctx.answerCbQuery('✅ O\'chirildi!');
        await ctx.editMessageText(`✅ O'chirildi!\n\n🚗 ${car?.name}\n📷 ${mediaCount} ta rasm ham o'chirildi.`);
    } catch (err) {
        console.error('delete_car_yes error:', err);
        await ctx.answerCbQuery('❌ Xato', { show_alert: true });
    }
});

bot.action('delete_car_no', async (ctx) => {
    await ctx.answerCbQuery('Bekor qilindi');
    await ctx.deleteMessage().catch(() => {});
});

// ============================================================
// === ALOQA (CONTACTS) — ADMIN ===
// ============================================================
bot.command('addcontact', adminOnly, async (ctx) => {
    addContactState.set(ctx.from.id, { step: 'name' });
    await ctx.reply(
        '👤 Yangi aloqa qo\'shish\n\nAdminning ismini yozing (masalan: Rizo):\n\nBekor qilish: /cancel'
    );
});

bot.command('listcontacts', adminOnly, async (ctx) => {
    const contacts = await queries.getAllContacts();
    if (contacts.length === 0) {
        await ctx.reply('Aloqalar yo\'q. /addcontact bilan qo\'shing.');
        return;
    }
    let text = '📞 Aloqa adminlar:\n\n';
    for (const c of contacts) {
        text += `👤 ${c.name} (@${c.username})\n`;
    }
    await ctx.reply(text);
});

bot.command('deletecontact', adminOnly, async (ctx) => {
    const contacts = await queries.getAllContacts();
    if (contacts.length === 0) { await ctx.reply('Aloqalar yo\'q.'); return; }
    await ctx.reply(
        '🗑️ Qaysi aloqani o\'chirmoqchisiz?',
        keyboards.deleteContactsKeyboard(contacts)
    );
});

bot.action(/^delete_contact:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) {
        await ctx.answerCbQuery('⛔ Ruxsat yo\'q', { show_alert: true });
        return;
    }
    const id = parseInt(ctx.match[1]);
    await queries.deleteContact(id);
    await ctx.answerCbQuery('✅ O\'chirildi!');
    await ctx.editMessageText('✅ Aloqa o\'chirildi!');
});

bot.action('delete_contact_cancel', async (ctx) => {
    await ctx.answerCbQuery('Bekor qilindi');
    await ctx.deleteMessage().catch(() => {});
});

// ============================================================
// === RANG O'ZGARTIRISH (RECOLOR) ===
// ============================================================
bot.command('recolor', adminOnly, async (ctx) => {
    const cars = await queries.getAllCars();
    if (cars.length === 0) { await ctx.reply('Moshinalar yo\'q. Avval /addcar qiling.'); return; }
    await ctx.reply('🎨 Rang o\'zgartirish\n\nQaysi moshina uchun?', keyboards.recolorCarsKeyboard(cars));
});

bot.action(/^recolor_car:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) {
        await ctx.answerCbQuery('⛔ Ruxsat yo\'q', { show_alert: true });
        return;
    }
    const carId = parseInt(ctx.match[1]);
    recolorState.set(ctx.from.id, { carId });
    await ctx.answerCbQuery();
    await ctx.editMessageText(
        `🎨 Rang o'zgartirish\n\n📸 O'zgartirmoqchi bo'lgan rasmni yuboring!\n\nBekor qilish: /cancel`
    );
});

bot.action(/^recolor_save:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) {
        await ctx.answerCbQuery('⛔ Ruxsat yo\'q', { show_alert: true });
        return;
    }
    const carId = parseInt(ctx.match[1]);
    const state = recolorState.get(ctx.from.id);
    if (!state?.resultBuffer) { await ctx.answerCbQuery('❌ Rasm topilmadi'); return; }
    try {
        const sent = await ctx.telegram.sendPhoto(
            ctx.from.id,
            { source: state.resultBuffer },
            { caption: `${state.detectedColor} rang` }
        );
        const fileId = sent.photo[sent.photo.length - 1].file_id;
        await queries.addMedia(carId, fileId, 'photo', `${state.detectedColor} rang`);
        recolorState.delete(ctx.from.id);
        await ctx.answerCbQuery('✅ Saqlandi!');
        await ctx.editMessageCaption(`✅ Rasm bazaga saqlandi!\n🎨 Rang: ${state.detectedColor}`);
    } catch (err) {
        console.error('recolor save error:', err);
        await ctx.answerCbQuery('❌ Saqlashda xatolik', { show_alert: true });
    }
});

bot.action(/^recolor_retry:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) {
        await ctx.answerCbQuery('⛔ Ruxsat yo\'q', { show_alert: true });
        return;
    }
    const state = recolorState.get(ctx.from.id);
    if (state) {
        recolorState.set(ctx.from.id, { carId: state.carId, imageBuffer: state.imageBuffer });
    }
    await ctx.answerCbQuery();
    await ctx.reply(
        `🎨 Boshqa rang kiriting:\n\n💡 Misol:\n• "qizil"\n• "to'q ko'k"\n• "RGB(255, 0, 0)"\n• "#FF5733"\n• "oltin sariq"\n\nBekor qilish: /cancel`
    );
});

bot.action('recolor_cancel', async (ctx) => {
    recolorState.delete(ctx.from!.id);
    await ctx.answerCbQuery('Bekor qilindi');
    await ctx.deleteMessage().catch(() => {});
});

// ============================================================
// === RASM HANDLER ===
// ============================================================
bot.on(message('photo'), async (ctx) => {
    const userId = ctx.from.id;

    // 1. Recolor — rasm kutilmoqda
    const rState = recolorState.get(userId);
    if (rState && !rState.imageBuffer && isAdmin(userId)) {
        try {
            const largest = ctx.message.photo[ctx.message.photo.length - 1];
            const fileLink = await ctx.telegram.getFileLink(largest.file_id);
            const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
            const imageBuffer = Buffer.from(response.data);
            recolorState.set(userId, { ...rState, imageBuffer });

            await ctx.reply(
                `✅ Rasm qabul qilindi!\n\n🎨 Endi rangni kiriting:\n\n💡 Misol:\n• "qizil" yoki "red"\n• "to'q ko'k"\n• "RGB(255, 0, 0)"\n• "#FF5733"\n• "oltin sariq"\n\nBekor qilish: /cancel`
            );
        } catch (err) {
            console.error('recolor photo error:', err);
            await ctx.reply('❌ Rasmni olishda xatolik. Qaytadan yuboring.');
        }
        return;
    }

    // 2. Rasm qo'shish rejimi
    const addState = adminState.get(userId);
    if (!addState || addState.mode !== 'add_media') return;

    try {
        const largest = ctx.message.photo[ctx.message.photo.length - 1];
        await queries.addMedia(addState.carId, largest.file_id, 'photo', ctx.message.caption || null);
        await ctx.reply('✅ Rasm qo\'shildi. Yana yuboring yoki /done');
    } catch (err) {
        console.error('photo error:', err);
        await ctx.reply('❌ Saqlashda xatolik.');
    }
});

bot.on(message('video'), async (ctx) => {
    const state = adminState.get(ctx.from.id);
    if (!state || state.mode !== 'add_media') return;
    try {
        await queries.addMedia(state.carId, ctx.message.video.file_id, 'video', ctx.message.caption || null);
        await ctx.reply('✅ Video qo\'shildi. Yana yuboring yoki /done');
    } catch (err) {
        console.error('video error:', err);
        await ctx.reply('❌ Saqlashda xatolik.');
    }
});

// ============================================================
// === AI ADMIN PANEL ===
// ============================================================
bot.command('analyze', adminOnly, async (ctx) => {
    const stats = await queries.getAIStats();
    await ctx.reply(
        `🤖 AI Tahlil Paneli\n\n📊 Jami media: ${stats.total} ta\n✅ Tahlil qilingan: ${stats.analyzed} ta\n⏳ Tahlil qilinmagan: ${stats.pending} ta\n\nQuyidagi amallardan birini tanlang:`,
        keyboards.aiAdminKeyboard(stats.pending, stats.analyzed)
    );
});

bot.command('aistats', adminOnly, async (ctx) => {
    const stats = await queries.getAIStats();
    await ctx.reply(
        `🤖 AI Statistika\n\n📊 Jami: ${stats.total}\n✅ Tahlil qilingan: ${stats.analyzed}\n⏳ Tahlilga kerak: ${stats.pending}\n\n` +
        (stats.pending > 0 ? `Tahlil: /analyze` : `Hammasi tayyor! 🎉`),
        keyboards.aiAdminKeyboard(stats.pending, stats.analyzed)
    );
});

bot.command('stop_analyze', adminOnly, async (ctx) => {
    if (!isAnalyzing) { await ctx.reply('Hozir tahlil ishlamayapti.'); return; }
    isAnalyzing = false;
    await ctx.reply('⏹ To\'xtatildi.');
});

bot.action('ai_analyze', async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) {
        await ctx.answerCbQuery('⛔ Ruxsat yo\'q', { show_alert: true });
        return;
    }
    await ctx.answerCbQuery();
    await ctx.deleteMessage().catch(() => {});
    await runAnalyze(ctx, false);
});

bot.action('ai_force_confirm', async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) {
        await ctx.answerCbQuery('⛔ Ruxsat yo\'q', { show_alert: true });
        return;
    }
    const stats = await queries.getAIStats();
    await ctx.answerCbQuery();
    await ctx.editMessageText(
        `⚠️ Diqqat!\n\n${stats.total} ta media qaytadan tahlil qilinadi.\nEski tahlillar o'chiriladi.\n\nDavom etamizmi?`,
        keyboards.forceConfirmKeyboard()
    );
});

bot.action('ai_force_yes', async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) {
        await ctx.answerCbQuery('⛔ Ruxsat yo\'q', { show_alert: true });
        return;
    }
    await ctx.answerCbQuery();
    await ctx.deleteMessage().catch(() => {});
    const resetCount = await queries.resetAllAIAnalysis();
    await ctx.reply(`🔄 ${resetCount} ta media qaytadan tahlilga qo'yildi.`);
    await runAnalyze(ctx, true);
});

bot.action('ai_force_no', async (ctx) => {
    await ctx.answerCbQuery('Bekor qilindi');
    await ctx.deleteMessage().catch(() => {});
});

bot.action('ai_stats', async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) {
        await ctx.answerCbQuery('⛔ Ruxsat yo\'q', { show_alert: true });
        return;
    }
    const stats = await queries.getAIStats();
    await ctx.answerCbQuery();
    await ctx.editMessageText(
        `🤖 AI Statistika\n\n📊 Jami: ${stats.total} ta\n✅ Tahlil qilingan: ${stats.analyzed} ta\n⏳ Qolgan: ${stats.pending} ta\n\nFoiz: ${stats.total > 0 ? Math.round(stats.analyzed / stats.total * 100) : 0}%`,
        keyboards.aiAdminKeyboard(stats.pending, stats.analyzed)
    );
});

// ============================================================
// === AI TAHLIL JARAYONI ===
// ============================================================
async function runAnalyze(ctx: Context, isForce: boolean): Promise<void> {
    if (isAnalyzing) {
        await ctx.reply('⚠️ Tahlil hozir ishlamoqda. /stop_analyze yoki kuting.');
        return;
    }

    const stats = await queries.getAIStats();
    if (stats.pending === 0) {
        await ctx.reply(`✅ Hamma media tahlil qilingan!\n\n📊 Jami: ${stats.total} ta`);
        return;
    }

    const estimatedMinutes = Math.ceil(stats.pending * 6 / 60);
    await ctx.reply(
        `🤖 ${isForce ? 'Hammasi qaytadan' : 'Tahlil'} boshlanyapti\n\n⏳ Tahlilga: ${stats.pending} ta\n⏱ Taxminan: ~${estimatedMinutes} daqiqa\n\nTo'xtatish: /stop_analyze`
    );

    isAnalyzing = true;
    let processed = 0, failed = 0, skipped = 0;
    const startTime = Date.now();
    const allPending = await queries.getUnanalyzedMedia(10000);
    console.log(`📋 Tahlil: ${allPending.length} ta`);

    for (const media of allPending) {
        if (!isAnalyzing) { console.log('⏹ To\'xtatildi'); break; }

        try {
            if (media.file_type !== 'photo') {
                await queries.updateMediaAI(media.id, {
                    description: 'Video material',
                    tags: ['video'],
                    colors: [],
                    material: '',
                    style: '',
                    placement: 'orindiq_uchun',
                });
                skipped++;
                continue;
            }

            const fileLink = await ctx.telegram.getFileLink(media.file_id);
            const response = await axios.get(fileLink.href, { responseType: 'arraybuffer', timeout: 30000 });
            const imageBuffer = Buffer.from(response.data);

            const analysis = await analyzeImage(imageBuffer);
            await queries.updateMediaAI(media.id, analysis);

            processed++;
            console.log(`✅ Media ${media.id} (${processed}/${allPending.length}): ${analysis.description.substring(0, 60)}...`);

            if (processed % 5 === 0) {
                await ctx.reply(
                    `⏳ Jarayon: ${processed}/${allPending.length}` + (failed > 0 ? `, ${failed} ta xato` : '')
                ).catch(() => {});
            }

            await new Promise(r => setTimeout(r, 2000));
        } catch (err: any) {
            console.error(`❌ Media ${media.id}:`, err.message || err);
            failed++;
        }
    }

    isAnalyzing = false;
    const duration = Math.round((Date.now() - startTime) / 1000);
    const finalStats = await queries.getAIStats();

    await ctx.reply(
        `✅ Tahlil yakunlandi!\n\n🤖 Yangi tahlil: ${processed} ta\n` +
        (skipped > 0 ? `⏭ Video o'tkazildi: ${skipped} ta\n` : '') +
        (failed > 0 ? `❌ Xatoliklar: ${failed} ta\n` : '') +
        `⏱ Vaqt: ${duration}s\n\n📊 Tahlil qilingan: ${finalStats.analyzed}/${finalStats.total} ta\n` +
        (failed > 0 ? `\n💡 Xato bo'lganlar uchun /analyze ni qayta ishlating` : `\n🎉 Hammasi tayyor!`)
    );
}

// ============================================================
// === MATN HANDLER ===
// 1. Aloqa qo'shish (admin) → ism → username
// 2. Recolor (admin) → rang
// 3. AI qidiruv → so'rov
// ============================================================
bot.on(message('text'), async (ctx) => {
    const userId = ctx.from.id;

    // 1. ALOQA QO'SHISH — admin kontakt qo'shmoqda
    const contactState = addContactState.get(userId);
    if (contactState && isAdmin(userId)) {
        if (ctx.message.text.startsWith('/')) return;

        if (contactState.step === 'name') {
            const name = ctx.message.text.trim();
            addContactState.set(userId, { step: 'username', name });
            await ctx.reply(
                `✅ Ism: ${name}\n\nEndi username ni yozing (masalan: @rizokhakimov yoki rizokhakimov):\n\nBekor qilish: /cancel`
            );
            return;
        }

        if (contactState.step === 'username') {
            const username = ctx.message.text.trim().replace('@', '');
            try {
                const contact = await queries.addContact(contactState.name!, username);
                addContactState.delete(userId);
                await ctx.reply(
                    `✅ Aloqa qo'shildi!\n\n👤 ${contact.name}\n🔗 @${contact.username}`
                );
            } catch (err: any) {
                if (err.code === '23505') {
                    await ctx.reply('❌ Bu username allaqachon mavjud. Boshqa username yozing yoki /cancel');
                } else {
                    console.error('addcontact error:', err);
                    await ctx.reply('❌ Xatolik. Qaytadan urinib ko\'ring yoki /cancel');
                }
            }
            return;
        }
    }

    // 2. RECOLOR — rang kiritish kutilmoqda
    const rState = recolorState.get(userId);
    if (rState?.imageBuffer && isAdmin(userId)) {
        if (ctx.message.text.startsWith('/')) return;

        const colorInput = ctx.message.text.trim();

        const processingMsg = await ctx.reply(
            `🎨 AI ishlayapti...\n"${colorInput}" rangga o'zgartirilmoqda...\n\n⏳ 30-60 soniya kuting...`
        );

        try {
            const result = await recolorSeatCover(rState.imageBuffer, colorInput);

            await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id).catch(() => {});

            recolorState.set(userId, {
                ...rState,
                resultBuffer: result.imageBuffer,
                detectedColor: result.detectedColor,
            });

            await ctx.replyWithPhoto(
                { source: result.imageBuffer },
                {
                    caption: `✨ Natija!\n🎨 Rang: ${result.detectedColor}\n\nSaqlaysizmi?`,
                    ...keyboards.saveRecoloredKeyboard(rState.carId),
                }
            );
        } catch (err: any) {
            await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id).catch(() => {});
            console.error('recolor error:', err);
            await ctx.reply(
                `❌ Xatolik yuz berdi: ${err.message}\n\nQaytadan urinib ko'ring yoki /cancel`
            );
        }
        return;
    }

    // 3. AI QIDIRUV
    const carId = aiSearchState.get(userId);
    if (!carId) return;
    if (ctx.message.text.startsWith('/')) return;
    if (ctx.message.text === '🚗 Moshinalar') return;

    const query = ctx.message.text.trim();
    aiSearchState.delete(userId);

    try {
        const loadingMsg = await ctx.reply('🤖 AI so\'rovni tahlil qilmoqda...');

        const keywords = await parseUserQuery(query);
        console.log('🔍 Kalit so\'zlar:', keywords);

        const results = await queries.searchMediaByKeywords(carId, keywords, 100);

        await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});

        if (results.length === 0) {
            await ctx.reply(
                `😔 Mos chexol topilmadi.\n\n🔍 Qidirildi: ${keywords.join(', ')}\n\n💡 Maslahat:\n• Boshqa rang yoki material yozing\n• Qisqaroq so'rov yuboring`,
                keyboards.aiSearchResultKeyboard(carId)
            );
            return;
        }

        const resultIds = results.map(r => r.id);
        aiResultCache.set(userId, { carId, results: resultIds });
        await showAiPage(ctx, resultIds, carId, 0);
    } catch (err) {
        console.error('AI search error:', err);
        await ctx.reply('❌ Qidirishda xatolik yuz berdi.');
    }
});

// ============================================================
// === ERROR HANDLER ===
// ============================================================
bot.catch((err, ctx) => { console.error('Bot xatosi:', err); });

// ============================================================
// === LAUNCH ===
// ============================================================
bot.launch().then(() => { console.log('🤖 Bot ishga tushdi!'); });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));