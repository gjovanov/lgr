// The one Windows-1251 codec lives in `config`, where `services` can reach it too (FR-25 §7.1, the VAT files).
export { encodeCp1251, decodeCp1251 } from 'config/cp1251'
