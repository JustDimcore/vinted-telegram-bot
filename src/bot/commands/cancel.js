import { clearFlow } from '../wizard.js';

export const command = 'cancel';
export const description = 'cmd-cancel';
export const order = 7;

/**
 * Aborts a running dialog.
 * @param {Object} ctx - Telegram context.
 * @returns {Promise<void>}
 */
export async function execute(ctx) {
    const wasRunning = clearFlow(ctx);
    await ctx.reply(ctx.t(wasRunning ? 'dialog-cancelled' : 'nothing-to-cancel'));
}
