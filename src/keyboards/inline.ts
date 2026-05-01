import { Markup } from 'telegraf';
import { Car } from '../types';

export function carsKeyboard(cars: Car[]) {
    const buttons = cars.map(car => [
        Markup.button.callback(`🚗 ${car.name}`, `car:${car.id}`)
    ]);
    return Markup.inlineKeyboard(buttons);
}

export function paginationKeyboard(carId: number, currentPage: number, totalPages: number) {
    const buttons = [];
    const navRow = [];

    if (currentPage > 0) navRow.push(Markup.button.callback('⬅️ Oldingi', `page:${carId}:${currentPage - 1}`));
    navRow.push(Markup.button.callback(`${currentPage + 1}/${totalPages}`, 'noop'));
    if (currentPage < totalPages - 1) navRow.push(Markup.button.callback('Keyingi ➡️', `page:${carId}:${currentPage + 1}`));

    buttons.push(navRow);
    buttons.push([Markup.button.callback('🔍 Tasvirlab qidirish (AI)', `ai_search:${carId}`)]);
    buttons.push([Markup.button.callback('🔙 Moshinalarga qaytish', 'back_to_cars')]);

    return Markup.inlineKeyboard(buttons);
}

export function aiPaginationKeyboard(carId: number, currentPage: number, totalPages: number) {
    const buttons = [];
    const navRow = [];

    if (currentPage > 0) navRow.push(Markup.button.callback('⬅️ Oldingi', `ai_page:${carId}:${currentPage - 1}`));
    navRow.push(Markup.button.callback(`${currentPage + 1}/${totalPages}`, 'noop'));
    if (currentPage < totalPages - 1) navRow.push(Markup.button.callback('Keyingi ➡️', `ai_page:${carId}:${currentPage + 1}`));

    buttons.push(navRow);
    buttons.push([Markup.button.callback('🔍 Yana qidirish', `ai_search:${carId}`)]);
    buttons.push([Markup.button.callback('🔙 Moshinalarga qaytish', 'back_to_cars')]);

    return Markup.inlineKeyboard(buttons);
}

export function adminCarsKeyboard(cars: Car[]) {
    const buttons = cars.map(car => [
        Markup.button.callback(`➕ ${car.name}`, `admin_add:${car.id}`)
    ]);
    buttons.push([Markup.button.callback('❌ Bekor qilish', 'admin_cancel')]);
    return Markup.inlineKeyboard(buttons);
}

export function aiSearchResultKeyboard(carId: number) {
    return Markup.inlineKeyboard([
        [Markup.button.callback('🔍 Yana qidirish', `ai_search:${carId}`)],
        [Markup.button.callback('🔙 Moshinalarga qaytish', 'back_to_cars')]
    ]);
}

export function aiAdminKeyboard(pending: number, analyzed: number) {
    const buttons = [];

    if (pending > 0) {
        buttons.push([Markup.button.callback(`🤖 Tahlil qilinmaganlarni qilish (${pending} ta)`, 'ai_analyze')]);
    }

    buttons.push([Markup.button.callback(`🔄 Hammasini qaytadan (${analyzed + pending} ta)`, 'ai_force_confirm')]);
    buttons.push([Markup.button.callback('📊 Statistika', 'ai_stats')]);

    return Markup.inlineKeyboard(buttons);
}

export function forceConfirmKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('✅ Ha, qaytadan tahlil qil', 'ai_force_yes')],
        [Markup.button.callback('❌ Bekor qilish', 'ai_force_no')]
    ]);
}
// Moshina o'chirish uchun tugmalar
export function deleteCarsKeyboard(cars: Car[]) {
    const buttons = cars.map(car => [
        Markup.button.callback(`🗑️ ${car.name}`, `delete_car_confirm:${car.id}`)
    ]);
    buttons.push([Markup.button.callback('❌ Bekor qilish', 'delete_car_no')]);
    return Markup.inlineKeyboard(buttons);
}

// Tasdiqlash tugmalari
export function deleteCarConfirmKeyboard(carId: number) {
    return Markup.inlineKeyboard([
        [Markup.button.callback('✅ Ha, o\'chir', `delete_car_yes:${carId}`)],
        [Markup.button.callback('❌ Yo\'q, bekor qil', 'delete_car_no')]
    ]);
}