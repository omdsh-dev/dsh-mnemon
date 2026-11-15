// Browser-only public helpers behind dsh-mnemon/client. No Source registration,
// default workbench, Host Context, or raw transport is part of this module.
export {
  installMemorySourceUI, memorySourcePageEntryId, MNEMON_SOURCE_PAGE_SLOT,
  MNEMON_SOURCE_CONFIGURATION_MUTATE, MNEMON_SOURCE_CONFIGURATION_READ,
  type MemorySourcePageComponent, type MemorySourcePageDefinition,
  type MemorySourcePageProps, type MemorySourceUIContribution, type MemorySourceUIContext, type MemorySourcePageNavigation,
} from './source-pages.tsx'
export type { MnemonSourceManagementClient, MemorySourcePageInstance } from './source-contracts.ts'
// The directory a page may offer as a per-run model choice, as its management
// client answers it; the pages read it and nothing else here drives it.
export type { TaskAgentModelCatalog, TaskAgentModelCatalogGroup, TaskAgentModelCatalogModel } from 'dsh-mnemon/contracts'
export {
  installMemoryComponentUI, supportsMemoryComponentSettingsSection, MNEMON_COMPONENT_FALLBACK_PRIORITY, MNEMON_COMPONENT_SETTINGS_SLOT, MNEMON_COMPONENT_STATUS_SLOT,
  type MemoryComponentConfigurationSnapshot, type MemoryComponentHost,
  type MemoryComponentSettingsComponent, type MemoryComponentSettingsProps, type MemoryComponentStatusComponent, type MemoryComponentStatusProps,
  type MemoryComponentUIContext, type MemoryComponentUIContribution,
} from './component-ui.tsx'
// What Memory Spaces' own settings are drawn with, the controls and styles dsh-mnemon drew them with.
export { AdvancedSection, memorySettingsStyles, SelectRow, SettingRow, SettingSelect, ToggleRow, type SettingOption } from './settings-controls.tsx'
export { PanelActions, useLive, useStaged, WriteFailure } from './settings-panel.tsx'
export { Callout, Reveal } from './feedback.tsx'
export { GlobalLocationSetting } from './GlobalLocationSetting.tsx'
export * from './page-kit.tsx'
export * from './page-controls.tsx'
export * from './page-client.tsx'
export { MnemonDialog, type MnemonDialogProps } from './MnemonDialog.tsx'
export { MnemonLogo } from './MnemonLogo.tsx'
export { useRequestVersion } from './use-request-version.ts'
export { appearanceClass } from './view-styles.ts'
export { translateEn, translateZh, type MnemonKey, type MnemonTranslate } from './locales.ts'
export { IconChevronLeftOutline14 } from './ui-icons.ts'
