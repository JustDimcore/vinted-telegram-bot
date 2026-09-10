import mongoose from "mongoose";
const { Schema, model, Types } = mongoose;

import ConfigurationManager from "./utils/config_manager.js";
import Logger from "./utils/logger.js";

const mongoConfig = ConfigurationManager.getMongoDBConfig;

// Connect to MongoDB
mongoose.connect(mongoConfig.uri)
    .then(() => Logger.info("Connected to MongoDB."))
    .catch((err) => Logger.error(err));

/**
 * Keys used in the preferences maps of a user and of a subscription.
 */
const Preference = {
    Countries: "countries",
    Language: "language",
    Currency: "currency",
    // Telegram has no mentions - a notification is either loud or silent instead.
    Silent: "silent",
};

const ShippableMap = {
    "pl": ["se", "lt", "sk", "hu", "ro", "cz", "dk", "hr", "fi"],
    "fr": ["nl", "be", "it", "es", "pt", "lu", "at"],
    "it": ["nl", "be", "fr", "es", "pt", "lu", "at"],
    "be": ["nl", "fr", "it", "es", "pt", "lu"],
    "es": ["nl", "be", "fr", "it", "pt", "lu"],
    "nl": ["be", "fr", "it", "es", "pt", "lu"],
    "pt": ["nl", "be", "fr", "it", "es"],
    "lu": ["nl", "be", "fr", "it", "es"],
    "fi": ["se", "dk", "lt", "pl"],
    "dk": ["se", "fi", "pl"],
    "se": ["fi", "dk", "pl"],
    "at": ["fr", "it"],
    "cz": ["sk", "pl"],
    "lt": ["fi", "pl"],
    "sk": ["cz", "pl"],
    "hr": ["pl"],
    "ro": ["pl", "gr"],
    "hu": ["pl"],
    "gr": ["ro"],
    "com": ["us"],
    "de": [],
    "uk": [],
};

// A Telegram user. telegramId is the numeric id of the account, stored as a string
// because ids of newer accounts exceed the safe integer range of JavaScript.
const userSchema = new Schema({
    telegramId: { type: String, unique: true, required: true },
    // Where the notifications go by default - for a private chat this equals telegramId.
    chatId: { type: String, required: true },
    username: { type: String, default: null },
    firstName: { type: String, default: null },
    languageCode: { type: String, default: 'en' },
    subscriptions: [{ type: Types.ObjectId, ref: 'Subscription' }],
    lastUpdated: { type: Date, default: Date.now },
    maxSubscriptions: { type: Number, default: ConfigurationManager.getUserConfig.max_subscriptions_default },
    preferences: { type: Map, default: {} },
});

// One saved Vinted search of one user. Replaces the Discord channel of the original bot:
// there is no channel to create, the items are delivered into a chat instead.
const subscriptionSchema = new Schema({
    subscriptionId: { type: String, unique: true, required: true },
    name: { type: String, required: true },
    url: { type: String, default: null },
    // Chat the items are sent to. Usually the private chat with the user, but it can also
    // be a group or a channel the bot was added to.
    chatId: { type: String, required: true },
    // Message thread of a forum group, when the subscription targets a topic.
    threadId: { type: Number, default: null },
    bannedKeywords: { type: [String], default: [] },
    isMonitoring: { type: Boolean, default: true },
    // Highest item id already reported, so a restart does not resend known items.
    lastSeenItemId: { type: Number, default: 0 },
    itemsFound: { type: Number, default: 0 },
    lastUpdated: { type: Date, default: Date.now },
    keepMessageSent: { type: Boolean, default: false },
    user: { type: Types.ObjectId, ref: 'User', default: null },
    preferences: { type: Map, default: {} },
});

const User = model('User', userSchema);
const Subscription = model('Subscription', subscriptionSchema);

Logger.info("Database models loaded.");

export { Preference, ShippableMap, User, Subscription };
