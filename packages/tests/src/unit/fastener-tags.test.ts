import { describe, it, expect } from 'bun:test'
// Import-pure module (no db/models) — this file must never boot Mongoose,
// same reasoning as amount-in-words.test.ts.
import {
  extractDinRefs,
  extractIsoRefs,
  extractEnRefs,
  extractDimensions,
  extractCoatings,
  extractFastenerFacets,
  formatDinTag,
} from 'services/biz/fastener-tags.utils'

const dinTags = (name: string) => extractDinRefs(name).map(formatDinTag)

describe('extractDinRefs', () => {
  it('plain spaced DIN', () => {
    expect(dinTags('БОЛТ М10Х100 - DIN 933 - K 8.8 - ZN')).toEqual(['DIN 933'])
  })

  it('attached DIN without space', () => {
    expect(dinTags('11100 СВРЕДЛО - Ф11 - HSS - DIN338')).toEqual(['DIN 338'])
  })

  it('class marker after spaced hyphen is NOT a variant', () => {
    expect(dinTags('БОЛТ М 5Х40 - DIN 933 - K6.8 - ZN')).toEqual(['DIN 933'])
    expect(dinTags('БОЛТ М10Х30 - DIN 933 - K 12.9')).toEqual(['DIN 933'])
    expect(dinTags('БОЛТ М3Х10 - DIN 7380 - 10.9 - ZN')).toEqual(['DIN 7380'])
  })

  it('whitelisted spaced letter variant, incl. Cyrillic lookalike', () => {
    expect(dinTags('ВИНТ - 6.3Х38 - DIN 7504 K - A2')).toEqual(['DIN 7504-K'])
    expect(dinTags('ВИНТ - САМОПР. - 2.9Х13 - DIN 7504 Р')).toEqual(['DIN 7504-P'])
    expect(dinTags('ВИНТ - САМОПР - 5.5Х100 - DIN 7504K')).toEqual(['DIN 7504-K'])
  })

  it('tight-hyphen digit variant only', () => {
    expect(dinTags('БОЛТ М6Х12 - DIN 7380-2 - А2')).toEqual(['DIN 7380-2'])
    expect(dinTags('ШПИЛКА - DIN 976 - М10Х100 - 8.8 - ZN')).toEqual(['DIN 976'])
  })

  it('multi-char continuations are never variants', () => {
    expect(dinTags('721030 СВРЕДЛ0 - Ф3 - DIN338-HSS-G - Со')).toEqual(['DIN 338'])
    expect(dinTags('138348 t.ФОТОСОЛ. ШЛЕМ - DIN9-13 - 100Х50')).toEqual(['DIN 9'])
  })

  it('steel grade after шпонка DIN is not a variant', () => {
    expect(dinTags('ШПОНКА - DIN 6885 - C45K - A 20Х12Х100')).toEqual(['DIN 6885'])
    expect(dinTags('ШПОНКА - DIN 6885 - C 45K - A6X6X30')).toEqual(['DIN 6885'])
  })

  it('A2 after unwhitelisted base is not eaten as variant A', () => {
    expect(dinTags('ШАЙБА - М10 - DIN 125 - A2')).toEqual(['DIN 125'])
  })

  it('two DINs in one name', () => {
    expect(dinTags('ЩИФТ - ПРУЖИНЕН - 6Х50 - DIN 7344/ISO 8748/')).toEqual(['DIN 7344'])
    expect(dinTags('ГАЙКА DIN 934 + БОЛТ DIN 933')).toEqual(['DIN 934', 'DIN 933'])
  })
})

describe('extractIsoRefs / extractEnRefs', () => {
  it('ISO in name', () => {
    expect(extractIsoRefs('БОЛТ М10Х20 - ISO 7380 - A2')).toEqual(['ISO 7380'])
    expect(extractIsoRefs('ЩИФТ - ПРУЖИНЕН - 6Х50 - DIN 7344/ISO 8748/')).toEqual(['ISO 8748'])
  })

  it('EN attached form canonicalizes with space', () => {
    expect(extractEnRefs('БОЛТ М12Х100 - EN14399-4 - K 10.9 - HDG')).toEqual(['EN 14399-4'])
  })

  it('EN not extracted from words ending in EN', () => {
    expect(extractEnRefs('ПРОДУКТ GREEN 14399')).toEqual([])
  })
})

describe('extractDimensions', () => {
  it('canonical Cyrillic М + Х', () => {
    expect(extractDimensions('БОЛТ М10Х100 - DIN 933')).toEqual(['М10Х100'])
    expect(extractDimensions('БОЛТ М 12Х100 - DIN 933 - 8.8 - HDG')).toEqual(['М12Х100'])
  })

  it('Latin/lowercase folds to canonical', () => {
    expect(extractDimensions('Senkschraube M8x30 A2')).toEqual(['М8Х30'])
    expect(extractDimensions('винт м8х30')).toEqual(['М8Х30'])
    expect(extractDimensions('ШПОНКА A28X16X80')).toEqual(['28Х16Х80'])
  })

  it('Ф prefix + decimals', () => {
    expect(extractDimensions('ШАЙБА - ПОДЛ. - Ф8Х24 - DIN 9021')).toEqual(['Ф8Х24'])
    expect(extractDimensions('НОЖ - ЗЕГЕ - 75Х2.5')).toEqual(['75Х2.5'])
    expect(extractDimensions('МИКСЕР - ПОЦ. - Ф80Х400 - 8мм')).toEqual(['Ф80Х400'])
  })

  it('comma decimal normalizes to dot', () => {
    expect(extractDimensions('МАКАРА - 50М кабел - 3Х1,5')).toEqual(['3Х1.5'])
  })

  it('three segments (thread × pitch × length)', () => {
    expect(extractDimensions('БОЛТ М10Х1.25Х40 - DIN 960 - 10.9 - BL')).toEqual(['М10Х1.25Х40'])
    expect(extractDimensions('ШПИЛКА - DIN 976 - М30Х2Х100 - А2-70')).toEqual(['М30Х2Х100'])
  })

  it('pipe-thread fractions never produce dimensions', () => {
    expect(extractDimensions('КРАН - ЪГЛ. СФЕР. - 1/2Х3/8 - С РОЗ.')).toEqual([])
    expect(extractDimensions('КРАН - СФЕР. - Ф20Х1/2 - С АД.')).toEqual([])
    expect(extractDimensions('3100 ПЕ - НИПЕЛ - М - 20Х1/2')).toEqual([])
  })

  it('slash-suffixed sizes never emit truncated numbers via backtracking', () => {
    expect(extractDimensions('БОЛТ 10Х100/94 - DIN 5526 - ZN')).toEqual([])
    expect(extractDimensions('ПВЦ - РАЗКЛОНИТЕЛ - 20Х20/87')).toEqual([])
  })

  it('multiple dimensions in one name', () => {
    expect(extractDimensions('ГУМЕНО КРАЧЕ - М6Х30/Ф32Х14')).toEqual(['М6Х30', 'Ф32Х14'])
    expect(extractDimensions('ГУМЕНО КРАЧЕ - М12Х50 / Ф45Х19')).toEqual(['М12Х50', 'Ф45Х19'])
  })

  it('letter directly before number is not a prefix', () => {
    expect(extractDimensions('БОЛТ BM 10Х35 - DIN 561 - K 8.8 - BL')).toEqual(['10Х35'])
  })

  it('trailing unit letters do not break the match', () => {
    expect(extractDimensions('ПАНТА - 125Х75ММ')).toEqual(['125Х75'])
    expect(extractDimensions('ДЪРЖАЧ - ДИСК - 10Х6мм')).toEqual(['10Х6'])
  })
})

describe('extractCoatings', () => {
  it('suffix codes', () => {
    expect(extractCoatings('БОЛТ М10Х100 - DIN 933 - K 8.8 - ZN')).toEqual(['ZN', '8.8'])
    expect(extractCoatings('БОЛТ М10Х100 - DIN 933 - K 10.9 - BL')).toEqual(['BL', '10.9'])
    expect(extractCoatings('АНКЕР - 12Х110 - HDG')).toEqual(['HDG'])
    expect(extractCoatings('БОЛТ М3Х10 - DIN 7380 - 10.9 -BL')).toEqual(['BL', '10.9'])
  })

  it('stainless class, Cyrillic and Latin, with -70 suffix', () => {
    expect(extractCoatings('БОЛТ М10Х100 - DIN 933 - A2')).toEqual(['A2'])
    expect(extractCoatings('БОЛТ - М24Х110 - DIN 933 - A4')).toEqual(['A4'])
    expect(extractCoatings('ШПИЛКА - DIN 976 - М30Х2Х100 - А2-70')).toEqual(['A2'])
  })

  it('yellow zinc + ПОЦ spelled out', () => {
    expect(extractCoatings('ПОДЛ. - Ф10 - DIN 125 - yellow zinc plated')).toEqual(['YELLOW ZINC'])
    expect(extractCoatings('138501 МИКСЕР - ПОЦ. - Ф80Х400 - 8мм')).toEqual(['ZN'])
  })

  it('brass', () => {
    expect(extractCoatings('ШАЙБА - М10 - DIN 125 - МЕСИНГ')).toEqual(['МЕСИНГ'])
    expect(extractCoatings('100407 ВИТЛО - МЕСИНГОВО - 11/4')).toEqual(['МЕСИНГ'])
  })

  it('no false strength class from diameters', () => {
    expect(extractCoatings('СВРЕДЛО - Ф8.8 - HSS')).toEqual([])
    expect(extractCoatings('СВРЕДЛО - Ф10.9')).toEqual([])
  })

  it('6.8 with attached К marker', () => {
    expect(extractCoatings('БОЛТ М 5Х40 - DIN 933 - K6.8 - ZN')).toEqual(['ZN', '6.8'])
  })
})

describe('extractFastenerFacets (integration of all facets)', () => {
  it('full bolt line', () => {
    const f = extractFastenerFacets('БОЛТ М10Х100 - DIN 933 - K 8.8 - ZN')
    expect(f.din.map(formatDinTag)).toEqual(['DIN 933'])
    expect(f.dims).toEqual(['М10Х100'])
    expect(f.coatings).toEqual(['ZN', '8.8'])
    expect(f.iso).toEqual([])
    expect(f.en).toEqual([])
  })

  it('EN structural bolt line', () => {
    const f = extractFastenerFacets('БОЛТ М12Х100 - EN14399-4 - K 10.9 - HDG')
    expect(f.en).toEqual(['EN 14399-4'])
    expect(f.dims).toEqual(['М12Х100'])
    expect(f.coatings).toEqual(['HDG', '10.9'])
    expect(f.din).toEqual([])
  })
})
