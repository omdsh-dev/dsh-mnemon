// Synthetic skill files for the list/detail scrolling regression (#553).
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function seedSkillsScroll({ dshHome }) {
  for (let index = 1; index <= 24; index++) {
    const name = `scroll-skill-${String(index).padStart(2, '0')}`
    const directory = join(dshHome, 'skills', name)
    const body = Array.from({ length: index === 1 || index === 18 ? 45 : 3 }, (_, step) =>
      `## Check ${step + 1}\n\nKeep the skill list in place while reading this synthetic document. Verify the selected skill, its instructions and the final check before continuing.`).join('\n\n')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Synthetic scrolling fixture ${index}.\n---\n\n# ${name}\n\n${body}\n`)
  }
}
