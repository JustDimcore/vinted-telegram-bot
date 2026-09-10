import crud from '../../crud.js';

export const command = 'admin_setmax';
export const description = 'cmd-admin-setmax';
export const adminOnly = true;
export const order = 91;

/**
 * Changes how many searches one user may run: /admin_setmax <telegram id> <limit>
 * @param {Object} ctx - Telegram context.
 * @returns {Promise<void>}
 */
export async function execute(ctx) {
    const [telegramId, rawLimit] = (ctx.match || '').trim().split(/\s+/);
    const limit = Number(rawLimit);

    if (!telegramId || !Number.isInteger(limit) || limit < 0) {
        await ctx.reply(ctx.t('admin-setmax-usage'), { parse_mode: 'HTML' });
        return;
    }

    const user = await crud.setUserMaxSubscriptions(telegramId, limit);
    if (!user) {
        await ctx.reply(ctx.t('user-not-found'));
        return;
    }

    await ctx.reply(ctx.t('admin-setmax-done', { user: telegramId, limit }));
}
