/**
 * O formato de um registro.
 *
 *     'DIA1'      4 bytes — marca, para reencontrar o começo depois de lixo
 *     tamanho     4 bytes — quantos bytes tem a carga
 *     crc         4 bytes — CRC-32 da carga
 *     carga       <tamanho> bytes
 *
 * A marca parece redundante num arquivo que só tem registros, e não é: quando
 * a energia cai no meio de uma escrita, o que sobra no fim do arquivo é meio
 * registro. A marca é o que permite dizer "daqui para frente não é registro
 * meu" com certeza, em vez de interpretar bytes soltos como um tamanho de
 * 3 GB e tentar alocar.
 *
 * O CRC cobre só a carga. O cabeçalho se protege pela marca e pela
 * consistência do tamanho com o que sobrou do arquivo.
 */

import { crc32 } from './crc32.js';

/** A marca que abre todo registro. */
export const MARCA = Buffer.from('DIA1', 'ascii');

/** Marca + tamanho + CRC. */
export const CABECALHO = 12;

/** Teto de sanidade: carga maior que isto é lixo, não registro. */
export const MAXIMO = 64 * 1024 * 1024;

/** O arquivo não está no formato esperado. */
export class ErroDeRegistro extends Error {
  constructor(mensagem, deslocamento = null) {
    super(deslocamento === null ? mensagem : `${mensagem} (byte ${deslocamento})`);
    this.name = 'ErroDeRegistro';
    this.deslocamento = deslocamento;
  }
}

/** Monta os bytes de um registro. */
export function montar(carga) {
  const corpo = Buffer.isBuffer(carga) ? carga : Buffer.from(String(carga), 'utf8');

  if (corpo.length > MAXIMO) {
    throw new ErroDeRegistro(`Registro de ${corpo.length} bytes passa do teto de ${MAXIMO}.`);
  }

  const cabecalho = Buffer.alloc(CABECALHO);

  MARCA.copy(cabecalho, 0);
  cabecalho.writeUInt32BE(corpo.length, 4);
  cabecalho.writeUInt32BE(crc32(corpo), 8);

  return Buffer.concat([cabecalho, corpo]);
}

/**
 * Por que a leitura devolve um motivo em vez de lançar.
 *
 * No fim de um arquivo que sobreviveu a uma queda, encontrar um registro
 * quebrado é **esperado**, não excepcional. Quem abre o diário precisa saber
 * onde parar e seguir a vida; uma exceção obrigaria a tratar o caso normal
 * como erro.
 */
export const MOTIVOS = ['ok', 'vazio', 'sem-marca', 'truncado', 'crc'];

/**
 * Lê um registro a partir de um deslocamento.
 *
 * @returns {{motivo: string, carga?: Buffer, proximo?: number, esperado?: number, obtido?: number}}
 */
export function ler(bytes, inicio) {
  if (inicio >= bytes.length) return { motivo: 'vazio' };

  if (inicio + CABECALHO > bytes.length) return { motivo: 'truncado', proximo: inicio };

  if (!bytes.subarray(inicio, inicio + 4).equals(MARCA)) return { motivo: 'sem-marca', proximo: inicio };

  const tamanho = bytes.readUInt32BE(inicio + 4);
  const declarado = bytes.readUInt32BE(inicio + 8);

  // Tamanho absurdo é lixo interpretado como cabeçalho; sem este teto, o
  // leitor tentaria alocar gigabytes por causa de quatro bytes trocados.
  if (tamanho > MAXIMO) return { motivo: 'truncado', proximo: inicio };

  const fim = inicio + CABECALHO + tamanho;

  if (fim > bytes.length) return { motivo: 'truncado', proximo: inicio };

  const carga = bytes.subarray(inicio + CABECALHO, fim);
  const calculado = crc32(carga);

  if (calculado !== declarado) {
    return { motivo: 'crc', proximo: inicio, esperado: declarado, obtido: calculado };
  }

  return { motivo: 'ok', carga, proximo: fim };
}

/**
 * Percorre todos os registros íntegros desde o começo.
 *
 * Devolve onde a leitura parou, que é exatamente o tamanho a que o arquivo
 * deve ser cortado para voltar a ser íntegro.
 */
export function varrer(bytes) {
  const registros = [];

  let i = 0;

  for (;;) {
    const lido = ler(bytes, i);

    if (lido.motivo !== 'ok') {
      return {
        registros,
        valido: i,
        sobra: bytes.length - i,
        motivo: lido.motivo,
        ...(lido.esperado === undefined ? {} : { esperado: lido.esperado, obtido: lido.obtido }),
      };
    }

    registros.push({ carga: lido.carga, deslocamento: i });
    i = lido.proximo;
  }
}
