import { useRef, useState } from 'react'
import { MemoryMarkdown, MemoryMarkdownEditor, MemoryPluginSurface, useRequestVersion, type MemorySourcePageProps } from 'dsh-mnemon/client'
import { managementError } from 'dsh-mnemon/client'

type SkillFile = { path: string; content: string; digest: string }

export function SkillFiles(props: MemorySourcePageProps) {
  return <SkillFilesView key={JSON.stringify([props.sourceInstanceKey, props.workspaceId, props.sessionId])} {...props} />
}

function SkillFilesView(props: MemorySourcePageProps) {
  const zh = props.locale.startsWith('zh'), t = (en: string, cn: string) => zh ? cn : en
  const [files, setFiles] = useState<string[]>([]), [roots, setRoots] = useState<string[]>([]), [path, setPath] = useState('')
  const [file, setFile] = useState<SkillFile>(), [content, setContent] = useState(''), [revision, setRevision] = useState('')
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [query, setQuery] = useState('')
  const [skills, setSkills] = useState<Array<{ name: string; description: string }>>([]), [definition, setDefinition] = useState('')
  const [creating, setCreating] = useState(false), [root, setRoot] = useState(''), [name, setName] = useState(''), [removing, setRemoving] = useState(false)
  const requests = useRequestVersion(), busyRef = useRef(false)
  const dirty = content !== (file?.content ?? '')

  async function run(operation: string, selected?: string) {
    if (!props.management || busyRef.current) return
    const mutation = ['save-skill-file', 'create-skill-file', 'archive-skill-file'].includes(operation)
    if (mutation && !props.writable) return
    const version = requests.begin()
    busyRef.current = true; setBusy(true); setError(''); setNotice('')
    try {
      const result = mutation
        ? await props.management.mutate(operation, { path: file?.path ?? path, content, digest: file?.digest ?? '', root, name }, { confirmed: true, expectedRevision: revision })
        : await props.management.read(operation, { path: selected ?? path, name: selected ?? '' })
      if (!requests.isCurrent(version)) return
      setRevision(result.revision)
      if (operation === 'native-skills') setSkills(result.value as typeof skills)
      else if (operation === 'native-skill') {
        const value = result.value as { content: string; truncated: boolean }
        setDefinition(value.content + (value.truncated ? t('\nContent was bounded.', '\n内容有截断。') : ''))
      } else if (operation === 'skill-roots') {
        const values = result.value as string[]
        setRoots(values); setRoot(values[0] ?? ''); setCreating(true); setFile(undefined); setContent(''); setName(''); setRemoving(false)
      } else if (operation === 'skill-files') setFiles(result.value as string[])
      else if (operation === 'archive-skill-file') {
        setFiles(values => values.filter(value => value !== file?.path)); setFile(undefined); setContent(''); setPath(''); setRemoving(false)
        setNotice(t('Removed from discovery. Recoverable file: ', '已从技能发现中移除。可恢复文件：') + String((result.value as { archivedPath: string }).archivedPath))
      } else {
        const value = result.value as SkillFile
        setFile(value); setPath(value.path); setContent(value.content); setCreating(false); setRemoving(false)
        if (operation === 'create-skill-file') setFiles(values => [...new Set([...values, value.path])])
      }
    } catch (error) { if (requests.isCurrent(version)) setError(managementError(error, zh)) }
    finally { if (requests.isCurrent(version)) { busyRef.current = false; setBusy(false) } }
  }

  function openFile(value: string) {
    if (dirty) { setNotice(t('Save or discard your edits before opening another file.', '请先保存或放弃修改，再打开其他文件。')); return }
    void run('skill-file', value)
  }

  return <MemoryPluginSurface title={t('Skill files', '技能文件')} description={t('Manage skills in your configured directories. Saves check the file version; removal preserves a recoverable copy.', '管理已配置目录中的技能。保存时校验文件版本；移除时保留可恢复副本。')}>
    <div className="mc-toolbar"><button disabled={busy} onClick={() => void run('skill-files')}>{t('Load skill directories', '读取技能目录')}</button><button disabled={busy || !props.writable || dirty} onClick={() => void run('skill-roots')}>{t('Create skill directory', '新建技能目录')}</button><input aria-label={t('Filter files', '筛选文件')} value={query} onChange={event => setQuery(event.target.value)} /></div>
    <ul>{files.filter(value => value.toLowerCase().includes(query.toLowerCase())).map(value => <li key={value}><button disabled={busy} onClick={() => openFile(value)}>{value}</button></li>)}</ul>
    {!creating && <><label>{t('Skill file path', '技能文件路径')}<input value={path} disabled={busy || dirty} onChange={event => setPath(event.target.value)} /></label><button disabled={busy || !path || dirty} onClick={() => openFile(path)}>{t('Open file', '打开文件')}</button></>}
    {creating && <div className="mc-fields"><label>{t('Registered directory', '已配置目录')}<select value={root} disabled={busy} onChange={event => setRoot(event.target.value)}>{roots.map(value => <option key={value}>{value}</option>)}</select>{!roots.length && <small>{t('Configure skill directories in this plugin first.', '请先在此插件中配置技能目录。')}</small>}</label><label>{t('Skill folder name', '技能目录名称')}<input value={name} disabled={busy} placeholder="release-check" pattern="[a-z0-9][a-z0-9-]{0,79}" onChange={event => setName(event.target.value)} /><small>{t('Lowercase letters, numbers and hyphens. Creates SKILL.md in this folder.', '使用小写字母、数字和连字符，在该目录中新建 SKILL.md。')}</small></label></div>}
    {(file || creating) && <MemoryMarkdownEditor label={t('Skill file content', '技能文件内容')} locale={props.locale} value={content} savedValue={file?.content ?? ''} disabled={!props.writable || creating && (!root || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(name))} saving={busy} onChange={setContent} onSave={() => void run(creating ? 'create-skill-file' : 'save-skill-file')} onDiscard={() => { setContent(file?.content ?? ''); setNotice('') }} />}
    {creating && <button disabled={busy} onClick={() => { setCreating(false); setContent(''); setPath(''); setName('') }}>{t('Cancel new skill', '取消新建技能')}</button>}
    {file && <details open={removing} onToggle={event => setRemoving(event.currentTarget.open)}><summary>{t('Remove this skill file', '移除此技能文件')}</summary><p>{t('This file will leave the skill catalog. A hidden sibling copy remains available for recovery.', '此文件将退出技能目录，原位置保留隐藏副本以便恢复。')}</p><code>{file.path}</code><footer><button disabled={busy || dirty || !props.writable} onClick={() => void run('archive-skill-file')}>{t('Remove and preserve a copy', '移除并保留副本')}</button></footer></details>}
    <h3>{t('Enabled native skills', '原生可用技能')}</h3><button disabled={busy} onClick={() => void run('native-skills')}>{t('Load native skill catalog', '读取原生技能目录')}</button>
    <ul>{skills.map(skill => <li key={skill.name}><strong>{skill.name}</strong> · {skill.description} <button disabled={busy} onClick={() => void run('native-skill', skill.name)}>{t('Read skill ', '读取技能 ')}{skill.name}</button></li>)}</ul>
    {definition && <MemoryMarkdown content={definition} locale={props.locale} />}
    {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
  </MemoryPluginSurface>
}
