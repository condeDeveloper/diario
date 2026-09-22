/**
 * diario — um log append-only com CRC32 e recuperação de queda.
 */

export { TABELA, crc32, crc32Texto } from './crc32.js';
export { CABECALHO, ErroDeRegistro, MARCA, MAXIMO, MOTIVOS, ler, montar, varrer } from './registro.js';
export { Diario } from './diario.js';
export { APAGADO, Deposito, lerEntrada, montarEntrada } from './deposito.js';
