import i18n, { type InitOptions, type TOptions } from "i18next";
import { initReactI18next, useTranslation as useReactI18nextTranslation } from "react-i18next";

import { DEFAULT_LOCALE, i18nextResources, supportedLocales } from "./locales";
import { assertValidLocaleMessages } from "./locale-validation";
import v3English from "./v3/en.json";
import v3Chinese from "./v3/zh-CN.json";

assertValidLocaleMessages(v3Chinese, v3English);
const documentLocale = typeof document === "undefined" ? "" : document.documentElement.lang;

const i18nextOptions: InitOptions = {
  resources: {
    ...i18nextResources,
    en: { ...i18nextResources.en, v3: v3English },
    "zh-CN": { ...i18nextResources["zh-CN"], v3: v3Chinese },
  },
  lng: supportedLocales.includes(documentLocale) ? documentLocale : DEFAULT_LOCALE,
  fallbackLng: DEFAULT_LOCALE,
  supportedLngs: supportedLocales,
  defaultNS: "translation",
  interpolation: { escapeValue: false },
  returnObjects: false,
  initAsync: false,
};

void i18n.use(initReactI18next).init(i18nextOptions).catch((error: unknown) => {
  console.error("Failed to initialize i18next", error);
});

export function t(key: string, options: TOptions = {}) {
  return i18n.t(key, options);
}

/** Local v3 UI messages, kept separate from the upstream language catalogs. */
export function v3t(key: string, options: TOptions = {}) {
  return i18n.t(key, { ...options, ns: "v3" });
}

export const useTranslation = useReactI18nextTranslation;
export { i18n };
