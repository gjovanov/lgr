import { describe, it, expect } from 'bun:test'
import {
  isValidActivityCode, orgIdentityUpdate, placeOfIssueOf, representativeOf,
  MAX_ACTIVITY_CODE_LENGTH,
} from 'config/party-identity'
import { representativeMoveOf } from 'config/contact-representative'

/**
 * FR-25a §3.5 / §3.7: the rules both renderers of a document, the settings page, the contact form and the API read.
 * Made-up names and places throughout.
 */

describe('where a document says it was issued', () => {
  it('its own place wins, printed as stored', () => {
    expect(placeOfIssueOf('Тестоград', { placeOfIssue: 'Другоград' })).toBe('Тестоград')
    expect(placeOfIssueOf(' Тестоград ', {})).toBe(' Тестоград ')
  })

  it('the company\'s place of issue stands in for a document that has none, trimmed', () => {
    for (const own of [undefined, null, '', '   ', 5]) {
      expect(placeOfIssueOf(own, { placeOfIssue: ' Другоград ' })).toBe('Другоград')
    }
  })

  it('neither: nothing, and for a company with no place of issue exactly the document\'s own value', () => {
    for (const org of [undefined, null, {}, { placeOfIssue: '' }, { placeOfIssue: '  ' }, { placeOfIssue: 7 }]) {
      expect(placeOfIssueOf(undefined, org)).toBe('')
      expect(placeOfIssueOf('', org)).toBe('')
      // what the form printed before: a blank place stays the blank place
      expect(placeOfIssueOf('  ', org)).toBe('  ')
    }
  })
})

describe('the МОЛ a party prints', () => {
  it('its own, trimmed; nothing when it has none', () => {
    expect(representativeOf({ representative: '  Лице Тестово ' })).toBe('Лице Тестово')
    for (const party of [undefined, null, {}, { representative: '' }, { representative: '   ' }, { representative: 3 }]) {
      expect(representativeOf(party)).toBe('')
    }
  })
})

describe('the company\'s activity code', () => {
  it('is digits in dot-joined groups, or nothing', () => {
    for (const ok of ['47', '47.5', '47.52', '01.11.1', ' 47.52 ', '', '   ', undefined]) expect(isValidActivityCode(ok)).toBe(true)
    for (const bad of ['47,52', '47.', '.47', '47..52', 'G47.52', '47 52', '47-52', '4.7.a']) expect(isValidActivityCode(bad)).toBe(false)
  })

  it('within its bound', () => {
    expect(isValidActivityCode('1'.repeat(MAX_ACTIVITY_CODE_LENGTH))).toBe(true)
    expect(isValidActivityCode('1'.repeat(MAX_ACTIVITY_CODE_LENGTH + 1))).toBe(false)
  })
})

describe('an org update\'s three fields', () => {
  it('sets what it carries, trimmed, and clears what it sends empty', () => {
    expect(orgIdentityUpdate({ representative: ' Лице Тестово ', placeOfIssue: '', activityCode: '  ' })).toEqual({
      set: { representative: 'Лице Тестово' },
      unset: ['placeOfIssue', 'activityCode'],
    })
  })

  it('leaves alone what it does not carry', () => {
    expect(orgIdentityUpdate({})).toEqual({ set: {}, unset: [] })
    expect(orgIdentityUpdate({ placeOfIssue: undefined, activityCode: '47.52' })).toEqual({ set: { activityCode: '47.52' }, unset: [] })
  })
})

describe('"move to the field": the МОЛ a contact still keeps as a notes line', () => {
  it('notes that are the line and nothing else: the name moves, the notes empty', () => {
    expect(representativeMoveOf('МОЛ: Лице Тестово', '')).toEqual({ name: 'Лице Тестово', notes: '' })
    expect(representativeMoveOf('  МОЛ: Лице Тестово  ', undefined)).toEqual({ name: 'Лице Тестово', notes: '' })
  })

  it('a line among others: exactly that line leaves, every other stays as it was', () => {
    expect(representativeMoveOf('Доставка в петък\nМОЛ: Лице Тестово\nПлаща по сметка', '')).toEqual({
      name: 'Лице Тестово',
      notes: 'Доставка в петък\nПлаща по сметка',
    })
    expect(representativeMoveOf('МОЛ: Лице Тестово\r\n  отстъпка 5%  ', '')).toEqual({ name: 'Лице Тестово', notes: 'отстъпка 5%' })
  })

  it('a field that already holds that name: only the line goes', () => {
    expect(representativeMoveOf('бележка\nМОЛ: Лице Тестово', ' Лице Тестово ')).toEqual({ name: 'Лице Тестово', notes: 'бележка' })
  })

  it('is not offered when a person has to decide, or there is nothing to move', () => {
    for (const [notes, held] of [
      ['МОЛ: Лице Тестово', 'Друго Лице'], // the field names someone else
      ['МОЛ: Лице Едно\nМОЛ: Лице Две', ''], // two lines are two people
      ['МОЛ: Лице Тестово · Създаден от партньор', ''], // a note joined to it
      ['бележка. МОЛ: Лице Тестово', ''], // inside a sentence, not a line
      ['МОЛ:Лице Тестово', ''], // not the old line's shape
      ['МОЛ: ', ''],
      ['моя бележка', ''],
      ['', ''],
      [undefined, ''],
    ] as const) {
      expect(representativeMoveOf(notes, held)).toBeUndefined()
    }
  })
})
