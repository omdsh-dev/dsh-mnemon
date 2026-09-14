import { describe, expect, it } from 'vitest'
import { newRecord } from 'dsh-mnemon/source-sdk'
import { changeMembership, prepareMessage, reserveFile, validateCollaborationRecord } from '../src/rooms.ts'
const scope = { storage: 'custom' as const, workspaceId: '/project', sessionId: 'creator' }
const room = () =>
  newRecord('room', 'Room', '', 'project', scope, {
    creator: 'creator',
    members: ['creator', 'member'],
    openJoin: false,
    status: 'open',
  })
describe('scoped collaboration', () => {
  it('checks creator powers, invitation, membership and addressed recipients', () => {
    const value = room(),
      records = [value]
    expect(() =>
      changeMembership(
        'remove-member',
        records,
        { id: value.id, memberId: 'creator' },
        { ...scope, sessionId: 'member' },
      ),
    ).toThrow(/creator/)
    expect(() => changeMembership('join-room', records, { id: value.id }, { ...scope, sessionId: 'outsider' })).toThrow(
      /invitation/,
    )
    expect(() =>
      prepareMessage(records, { id: value.id, message: 'hello', recipients: ['outsider'] }, scope, []),
    ).toThrow(/members/)
    const message = prepareMessage(records, { id: value.id, message: 'hello', recipients: ['member'] }, scope, [])
    expect(message.data).toMatchObject({
      sender: 'creator',
      recipients: ['member'],
      readBy: ['creator'],
      status: 'queued',
    })
    expect(() =>
      prepareMessage(
        records,
        { id: value.id, message: 'hello', recipients: ['member'] },
        { ...scope, workspaceId: '/other' },
        [],
      ),
    ).toThrow(/project/)
    changeMembership('close-room', records, { id: value.id }, scope)
    expect(value.state).toBe('archived')
    expect(value.data.members).toEqual(['creator', 'member'])
  })
  it('fences conflicting file reservations, renews owned leases and reclaims expiry', () => {
    const records: ReturnType<typeof room>[] = []
    const first = reserveFile(records, '/project/app.ts', scope, 30)
    expect(() => reserveFile(records, '/project/app.ts', { ...scope, sessionId: 'member' }, 30)).toThrow(
      /another session/,
    )
    expect(reserveFile(records, '/project/app.ts', scope, 60).id).toBe(first.id)
    first.data.expiresAt = new Date(0).toISOString()
    const next = reserveFile(records, '/project/app.ts', { ...scope, sessionId: 'member' }, 30)
    expect(next.id).not.toBe(first.id)
    expect(first.state).toBe('archived')
  })
})

it('rejects malformed imported rooms and directed message receipts', () => {
  const value = room()
  value.data.members = ['member']
  expect(() => validateCollaborationRecord(value)).toThrow(/membership/)
  const valid = room(),
    message = prepareMessage([valid], { id: valid.id, message: 'x', recipients: ['member'] }, scope, [])
  message.data.readBy = ['outsider']
  expect(() => validateCollaborationRecord(message)).toThrow(/message/)
})
