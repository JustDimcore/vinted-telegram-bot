import { InlineKeyboard } from 'grammy';
import crud from '../crud.js';
import Logger from '../utils/logger.js';
import ConfigurationManager from '../utils/config_manager.js';
import LanguageService from '../utils/language.js';
import t from '../t.js';
import TelegramService from './telegram_service.js';
import { escapeHtml } from '../bot/components/item_message.js';

const telegramConfig = ConfigurationManager.getTelegramConfig;

/**
 * Hours since a date.
 * @param {Date} date - The date.
 * @returns {number} - Hours passed.
 */
function hoursAgo(date) {
    return (Date.now() - new Date(date).getTime()) / (1000 * 60 * 60);
}

/**
 * Asks about searches nobody looks at any more, and removes the ones nobody answers for.
 *
 * The Discord original kept a message component collector alive for a whole day. Telegram
 * has no collectors, so the state lives in the database instead: keepMessageSent marks a
 * pending question, and the next run of this check enforces the deadline.
 * @returns {Promise<void>}
 */
export async function checkSubscriptionInactivity() {
    if (!telegramConfig.subscription_inactivity_enabled) {
        return;
    }

    const deadlineHours = telegramConfig.subscription_inactivity_hours + telegramConfig.subscription_inactivity_delete_hours;

    try {
        const subscriptions = await crud.getAllSubscriptions();

        for (const subscription of subscriptions) {
            const idleHours = hoursAgo(subscription.lastUpdated);

            if (subscription.keepMessageSent) {
                // The question was asked and the answer never came.
                if (idleHours > deadlineHours) {
                    Logger.info(`Deleting subscription ${subscription.subscriptionId}: no answer to the inactivity question`);
                    await crud.deleteSubscription(subscription.subscriptionId);

                    const lang = LanguageService.resolve(subscription.user?.languageCode);
                    await TelegramService.sendText(
                        subscription.chatId,
                        t(lang, 'subscription-deleted-inactive', { name: escapeHtml(subscription.name) })
                    ).catch(() => {});
                }
                continue;
            }

            if (idleHours <= telegramConfig.subscription_inactivity_hours) {
                continue;
            }

            const lang = LanguageService.resolve(subscription.user?.languageCode);
            const keyboard = new InlineKeyboard()
                .text(`✅ ${t(lang, 'keep-subscription')}`, `keep:${subscription.subscriptionId}`)
                .text(`🗑 ${t(lang, 'delete')}`, `drop:${subscription.subscriptionId}`);

            try {
                await TelegramService.sendText(
                    subscription.chatId,
                    t(lang, 'inactivity-question', {
                        name: escapeHtml(subscription.name),
                        hours: telegramConfig.subscription_inactivity_delete_hours,
                    }),
                    { reply_markup: keyboard }
                );

                await crud.setSubscriptionKeepMessageSent(subscription.subscriptionId, true);
            } catch (error) {
                Logger.debug(`Could not ask about subscription ${subscription.subscriptionId}: ${error.message}`);
            }
        }
    } catch (error) {
        Logger.error(`Error checking subscription inactivity: ${error.message}`);
    }
}
