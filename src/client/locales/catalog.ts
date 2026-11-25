import type { MnemonLocaleId } from '../localized-text.ts'
import { coreDe } from './de.ts'
import { coreEn } from './en.ts'
import { coreEs } from './es.ts'
import { coreFr } from './fr.ts'
import { coreJa } from './ja.ts'
import { corePt } from './pt.ts'
import { coreRu } from './ru.ts'
import { zh, type CoreMnemonKey } from './zh.ts'

export type { CoreMnemonKey }

export const coreLocales: Readonly<Record<MnemonLocaleId, Record<CoreMnemonKey, string>>> = {
  en: coreEn,
  zh,
  ja: coreJa,
  es: coreEs,
  fr: coreFr,
  de: coreDe,
  ru: coreRu,
  pt: corePt,
}
