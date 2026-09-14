// Browser-only public helpers behind dsh-mnemon/client. No Source registration,
// default workbench, Host Context, or raw transport is part of this module.
export {
  installMemorySourceUI, installMemorySourceOverlayUI, memorySourcePageEntryId, MNEMON_SOURCE_PAGE_SLOT, MNEMON_SOURCE_OVERLAY_SLOT,
  MNEMON_SOURCE_CONFIGURATION_MUTATE, MNEMON_SOURCE_CONFIGURATION_READ,
  type MemorySourcePageComponent, type MemorySourcePageDefinition,
  type MemorySourcePageProps, type MemorySourceUIContribution, type MemorySourceUIContext, type MemorySourcePageNavigation,
} from './source-pages.tsx'
export type { MnemonSourceManagementClient, MemorySourcePageInstance, MemorySourceManagementDirectory } from './source-contracts.ts'
export * from './page-kit.tsx'
export * from './page-client.tsx'
export { MnemonDialog, type MnemonDialogProps } from './MnemonDialog.tsx'
export { MnemonLogo } from './MnemonLogo.tsx'
export { useRequestVersion } from './use-request-version.ts'
export { appearanceClass } from './view-styles.ts'
export { translateEn, translateZh, type MnemonKey, type MnemonTranslate } from './locales.ts'
export { IconChevronLeftOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'

export { memoryPluginTokens, memoryPluginStyles, MemoryPluginSurface, MemoryPluginMetrics, MemoryPluginNotice } from './plugin-ui.tsx'
export { MemoryMarkdown, MemoryMarkdownEditor, type MemoryMarkdownEditorProps } from './plugin-editor.tsx'
export { MemoryFileEditor, type MemoryFileEditorProps, type MemoryTextFile } from './plugin-files.tsx'

export * from './context-access.tsx'
export * from './collection/client.tsx'
export * from './collection/action-client.tsx'
export * from './collection/lookup-client.tsx'
