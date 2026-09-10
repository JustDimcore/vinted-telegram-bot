import { InlineKeyboard } from 'grammy';
import crud from '../../crud.js';

export const command = 'delete_all';
export const description = 'cmd-delete-all';
export const order = 8;

/**
 * Asks for confirmation before removing every search of the user.
 * @param {Object} ctx - Telegram context.
 * @returns {Promise<void>}
 */
export async function execute(ctx) {
    const subscriptions = await crud.getSubscriptionsByTelegramId(ctx.from.id);

    if (subscriptions.length === 0) {
        await ctx.reply(ctx.t('no-subscriptions'));
        return;
    }

    const keyboard = new InlineKeyboard()
        .text(`🗑 ${ctx.t('yes-delete')}`, 'wipeok')
        .text(`↩️ ${ctx.t('cancel')}`, 'list');

    await ctx.reply(ctx.t('delete-all-confirm', { count: subscriptions.length }), {
        parse_mode: 'HTML',
        reply_markup: keyboard,
    });
}
