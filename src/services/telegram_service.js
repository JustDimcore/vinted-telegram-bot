import { GrammyError, HttpError } from 'grammy';
import Logger from '../utils/logger.js';
import crud from '../crud.js';

// Telegram accepts roughly 30 messages per second in total and about one message per
// second into a single chat. Every outgoing message of the bot goes through this queue,
// so a burst of new items cannot get the bot rate limited.
const GLOBAL_MIN_INTERVAL_MS = 40;
const CHAT_MIN_INTERVAL_MS = 1100;
const MAX_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 500;
// Above this many remembered chats the stale entries are cleaned out.
const CHAT_TIMESTAMP_LIMIT = 500;

// Errors that mean the chat will never accept a message again. Retrying them is pointless,
// the subscriptions delivering there are stopped instead.
const PERMANENT_ERROR_PATTERNS = [
    'bot was blocked by the user',
    'user is deactivated',
    'chat not found',
    'bot was kicked',
    'have no rights to send a message',
    'not enough rights',
    'group chat was upgraded',
    'peer_id_invalid',
];

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Serializes every outgoing Telegram call and applies the rate limits.
 */
class TelegramService {
    static bot = null;
    static queue = [];
    static lastSendAtByChat = new Map();
    static lastSendAt = 0;
    static workerRunning = false;

    /**
     * Binds the service to a bot instance.
     * @param {import('grammy').Bot} bot - The bot used for sending.
     */
    static init(bot) {
        this.bot = bot;
    }

    /**
     * Queues an API call for a chat and waits for its result.
     * @param {string|number} chatId - Target chat.
     * @param {Function} run - Function performing the call, receives the bot api.
     * @returns {Promise<any>} - Result of the call.
     */
    static enqueue(chatId, run) {
        return new Promise((resolve, reject) => {
            this.queue.push({ chatId: String(chatId), run, resolve, reject, attempts: 0 });
            this.startWorker();
        });
    }

    static startWorker() {
        if (this.workerRunning) {
            return;
        }

        this.workerRunning = true;
        this.work().catch(error => {
            Logger.error(`Telegram send worker crashed: ${error.message}`);
        }).finally(() => {
            this.workerRunning = false;
            // A job may have arrived while the loop was shutting down.
            if (this.queue.length > 0) {
                this.startWorker();
            }
        });
    }

    /**
     * Picks the first job whose chat is allowed to receive a message again.
     * @returns {{index: number, waitMs: number}} - Index of the job, or the time to wait.
     */
    static pickNextJob() {
        const now = Date.now();
        let earliest = Infinity;

        for (let i = 0; i < this.queue.length; i++) {
            const chatId = this.queue[i].chatId;
            const readyAt = (this.lastSendAtByChat.get(chatId) ?? 0) + CHAT_MIN_INTERVAL_MS;

            if (readyAt <= now) {
                return { index: i, waitMs: 0 };
            }

            earliest = Math.min(earliest, readyAt);
        }

        return { index: -1, waitMs: Math.max(earliest - now, 10) };
    }

    static async work() {
        while (this.queue.length > 0) {
            const { index, waitMs } = this.pickNextJob();

            if (index === -1) {
                await sleep(waitMs);
                continue;
            }

            const globalWait = this.lastSendAt + GLOBAL_MIN_INTERVAL_MS - Date.now();
            if (globalWait > 0) {
                await sleep(globalWait);
            }

            const [job] = this.queue.splice(index, 1);

            this.lastSendAt = Date.now();
            this.lastSendAtByChat.set(job.chatId, Date.now());
            this.pruneChatTimestamps();

            try {
                const result = await job.run(this.bot.api);
                job.resolve(result);
            } catch (error) {
                await this.handleFailure(job, error);
            }
        }
    }

    /**
     * Drops the timestamps of chats that have not been written to for a long time,
     * so the map does not grow with every chat the bot ever answered.
     */
    static pruneChatTimestamps() {
        if (this.lastSendAtByChat.size < CHAT_TIMESTAMP_LIMIT) {
            return;
        }

        const cutoff = Date.now() - CHAT_MIN_INTERVAL_MS * 10;
        for (const [chatId, at] of this.lastSendAtByChat) {
            if (at < cutoff) {
                this.lastSendAtByChat.delete(chatId);
            }
        }
    }

    /**
     * Decides whether a failed job is retried, dropped, or ends the whole chat.
     * @param {Object} job - The failed job.
     * @param {Error} error - The error thrown by the API call.
     * @returns {Promise<void>}
     */
    static async handleFailure(job, error) {
        job.attempts += 1;

        if (error instanceof GrammyError) {
            const description = (error.description || '').toLowerCase();

            if (error.error_code === 429) {
                // Telegram says how long to wait; the whole chat is held back for that long.
                const retryAfter = (error.parameters?.retry_after ?? 1) * 1000;
                Logger.warn(`Rate limited by Telegram for chat ${job.chatId}, waiting ${retryAfter}ms`);
                this.lastSendAtByChat.set(job.chatId, Date.now() + retryAfter);

                if (job.attempts < MAX_ATTEMPTS) {
                    this.queue.push(job);
                    return;
                }
            }

            if (PERMANENT_ERROR_PATTERNS.some(pattern => description.includes(pattern))) {
                Logger.warn(`Chat ${job.chatId} is not reachable (${error.description}), stopping its subscriptions`);
                try {
                    const stopped = await crud.stopSubscriptionsOfChat(job.chatId);
                    if (stopped > 0) {
                        Logger.info(`Stopped ${stopped} subscription(s) of chat ${job.chatId}`);
                    }
                } catch (stopError) {
                    Logger.error(`Failed to stop subscriptions of chat ${job.chatId}: ${stopError.message}`);
                }

                job.reject(error);
                return;
            }
        }

        const retryable = error instanceof HttpError || error instanceof GrammyError;
        if (retryable && job.attempts < MAX_ATTEMPTS) {
            await sleep(RETRY_BASE_DELAY_MS * job.attempts);
            this.queue.push(job);
            return;
        }

        Logger.error(`Failed to send to chat ${job.chatId}: ${error.message}`);
        job.reject(error);
    }

    /**
     * Sends a text message.
     * @param {string|number} chatId - Target chat.
     * @param {string} text - HTML formatted text.
     * @param {Object} [extra] - Additional Telegram options.
     * @returns {Promise<any>} - The sent message.
     */
    static sendText(chatId, text, extra = {}) {
        return this.enqueue(chatId, api => api.sendMessage(chatId, text, {
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
            ...extra,
        }));
    }

    /**
     * Sends a single photo with a caption.
     * @param {string|number} chatId - Target chat.
     * @param {string} photo - Photo URL.
     * @param {string} caption - HTML formatted caption.
     * @param {Object} [extra] - Additional Telegram options.
     * @returns {Promise<any>} - The sent message.
     */
    static sendPhoto(chatId, photo, caption, extra = {}) {
        return this.enqueue(chatId, api => api.sendPhoto(chatId, photo, {
            caption,
            parse_mode: 'HTML',
            ...extra,
        }));
    }

    /**
     * Sends an album. Telegram allows no inline keyboard below an album, so the caller
     * has to put every link into the caption of the first photo.
     * @param {string|number} chatId - Target chat.
     * @param {Array<Object>} media - Media group entries.
     * @param {Object} [extra] - Additional Telegram options.
     * @returns {Promise<any>} - The sent messages.
     */
    static sendMediaGroup(chatId, media, extra = {}) {
        return this.enqueue(chatId, api => api.sendMediaGroup(chatId, media, extra));
    }
}

export default TelegramService;
