import { Context, MiddlewareFn } from 'telegraf';
import dotenv from 'dotenv';

dotenv.config();

export const ADMIN_IDS: number[] = (process.env.ADMIN_IDS || '')
    .split(',')
    .map(id => parseInt(id.trim()))
    .filter(id => !isNaN(id));

export function isAdmin(userId: number): boolean {
    return ADMIN_IDS.includes(userId);
}

export const adminOnly: MiddlewareFn<Context> = async (ctx, next) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) {
        await ctx.reply('⛔ Bu komanda faqat adminlar uchun.');
        return;
    }
    return next();
};