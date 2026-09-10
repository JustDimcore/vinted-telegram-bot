/**
 * Multi step dialogs of the bot.
 *
 * Telegram has no equivalent of a Discord modal, so anything that needs more than one
 * value is asked for one message at a time. The state lives in memory: it is short lived
 * by nature, and after a restart the user simply starts the dialog again.
 */
const states = new Map();
const flows = new Map();

// A dialog nobody finishes must not keep the user trapped: the next command clears it anyway,
// and this timeout drops the leftovers of abandoned dialogs.
const STATE_TTL_MS = 15 * 60 * 1000;

function stateKey(ctx) {
    return `${ctx.chat.id}:${ctx.from.id}`;
}

/**
 * Registers the handler of a dialog.
 * @param {string} name - Name of the flow.
 * @param {Function} handler - Called as handler(ctx, state) for every answer.
 */
export function registerFlow(name, handler) {
    flows.set(name, handler);
}

/**
 * Starts a dialog for the current user.
 * @param {Object} ctx - Telegram context.
 * @param {string} flow - Name of the flow.
 * @param {string} step - First step.
 * @param {Object} [data] - Initial data.
 */
export function startFlow(ctx, flow, step, data = {}) {
    states.set(stateKey(ctx), { flow, step, data, createdAt: Date.now() });
}

/**
 * Returns the running dialog of the current user, if any.
 * @param {Object} ctx - Telegram context.
 * @returns {Object|null} - The state or null.
 */
export function getFlow(ctx) {
    const key = stateKey(ctx);
    const state = states.get(key);

    if (!state) {
        return null;
    }

    if (Date.now() - state.createdAt > STATE_TTL_MS) {
        states.delete(key);
        return null;
    }

    return state;
}

/**
 * Moves the running dialog to another step.
 * @param {Object} ctx - Telegram context.
 * @param {string} step - Next step.
 * @param {Object} [data] - Data merged into the state.
 */
export function setStep(ctx, step, data = {}) {
    const state = getFlow(ctx);
    if (!state) {
        return;
    }

    state.step = step;
    state.data = { ...state.data, ...data };
    state.createdAt = Date.now();
}

/**
 * Ends the dialog of the current user.
 * @param {Object} ctx - Telegram context.
 * @returns {boolean} - True when a dialog was running.
 */
export function clearFlow(ctx) {
    return states.delete(stateKey(ctx));
}

/**
 * Hands an answer to the handler of the running dialog.
 * @param {Object} ctx - Telegram context.
 * @returns {Promise<boolean>} - True when a dialog handled the message.
 */
export async function dispatchFlow(ctx) {
    const state = getFlow(ctx);
    if (!state) {
        return false;
    }

    const handler = flows.get(state.flow);
    if (!handler) {
        clearFlow(ctx);
        return false;
    }

    await handler(ctx, state);
    return true;
}
