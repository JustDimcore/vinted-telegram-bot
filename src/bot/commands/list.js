import crud from '../../crud.js';
import { renderSubscriptionList } from '../components/subscription_view.js';

export const command = 'list';
export const description = 'cmd-list';
export const order = 4;

/**
 * Shows every search of the user with a button per entry.
 * @param {Object} ctx - Telegram context.
 * @returns {Promise<void>}
 */
export async function execute(ctx) {
    const user = await crud.getUserByTelegramId(ctx.from.id);
    const subscriptions = await crud.getSubscriptionsByTelegramId(ctx.from.id);

    const { text, keyboard } = renderSubscriptionList({ user, subscriptions, lang: ctx.lang });

    await ctx.reply(text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: keyboard,
    });
}
