import { defineTranslations } from "@getpaseo/plugin/client";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";

export const messages = defineTranslations({ resources: { en, "zh-CN": zhCN } });

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
