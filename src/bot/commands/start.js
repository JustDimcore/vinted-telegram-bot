import { InlineKeyboard } from 'grammy';
import { escapeHtml } from '../components/item_message.js';

export const command = 'start';
export const description = 'cmd-start';
export const order = 1;

/**
 * Greets the user and explains the first step.
 * @param {Object} ctx - Telegram context.
 * @returns {Promise<void>}
 */
export async function execute(ctx) {
    const name = ctx.from.first_name || ctx.from.username || '';

    const text = [
        `👋 <b>${escapeHtml(ctx.t('welcome-title', { name }))}</b>`,
        '',
        escapeHtml(ctx.t('welcome-body')),
        '',
        `<b>${escapeHtml(ctx.t('how-to-start'))}</b>`,
        escapeHtml(ctx.t('how-to-start-1')),
        escapeHtml(ctx.t('how-to-start-2')),
        escapeHtml(ctx.t('how-to-start-3')),
    ].join('\n');

    const keyboard = new InlineKeyboard()
        .text(`📋 ${ctx.t('my-searches')}`, 'list');

    await ctx.reply(text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: keyboard,
    });
}
