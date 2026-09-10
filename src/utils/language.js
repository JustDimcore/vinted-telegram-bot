import fs from 'fs';
import path from 'path';
import Logger from './logger.js';

const __dirname = path.resolve();

/**
 * Loads the JSON files from the locales folder and resolves translation keys.
 *
 * Telegram reports the client language as a short code ("en", "ru") or as a
 * regional variant ("en-GB", "pt-BR"), so the region is stripped before lookup
 * and anything unknown falls back to English.
 */
class LanguageService {
    static localesDir = path.join(__dirname, 'locales');
    static languages = {};
    static fallbackLanguage = 'en';

    static initialize() {
        const files = fs.readdirSync(this.localesDir).filter(file => file.endsWith('.json'));
        files.forEach(file => {
            const filePath = path.join(this.localesDir, file);
            const lang = path.basename(file, '.json');
            Logger.info(`Loading language file for ${lang}`);
            this.languages[lang] = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        });
    }

    /**
     * Normalizes a Telegram language code to one of the loaded locales.
     * @param {string|undefined} lang - Language code reported by Telegram.
     * @returns {string} - Name of a loaded locale.
     */
    static resolve(lang) {
        if (!lang) {
            return this.fallbackLanguage;
        }

        if (this.languages[lang]) {
            return lang;
        }

        const base = String(lang).split('-')[0].toLowerCase();
        if (this.languages[base]) {
            return base;
        }

        return this.fallbackLanguage;
    }

    static getText(lang, key) {
        const resolved = this.resolve(lang);

        if (this.languages[resolved] && this.languages[resolved][key]) {
            return this.languages[resolved][key];
        }

        // Locales other than English may be incomplete; English fills in the gaps.
        if (resolved !== this.fallbackLanguage && this.languages[this.fallbackLanguage]?.[key]) {
            return this.languages[this.fallbackLanguage][key];
        }

        return `Missing translation for "${key}"`;
    }

    /**
     * Lists the loaded locales.
     * @returns {Array<string>} - Locale names.
     */
    static available() {
        return Object.keys(this.languages).sort();
    }
}

// Initialize the languages when the module is loaded
LanguageService.initialize();

export default LanguageService;
