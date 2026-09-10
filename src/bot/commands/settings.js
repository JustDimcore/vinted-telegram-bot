import crud from '../../crud.js';
import { renderSettings } from '../components/settings_view.js';

export const command = 'settings';
export const description = 'cmd-settings';
export const order = 5;

/**
 * Shows the settings of the user.
 * @param {Object} ctx - Telegram context.
 * @returns {Promise<void>}
 */
export async function execute(ctx) {
    const user = await crud.getUserByTelegramId(ctx.from.id);
    const { text, keyboard } = renderSettings({ user, lang: ctx.lang });

    await ctx.reply(text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: keyboard,
    });
}
