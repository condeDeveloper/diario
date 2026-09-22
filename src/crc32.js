/**
 * CRC-32, o mesmo do zip, do gzip e do PNG.
 *
 * Não é criptografia: quem quiser forjar um registro recalcula o CRC em dois
 * segundos. Ele existe para pegar **corrupção acidental** — o setor que veio
 * meio gravado, o byte que o disco trocou, o registro que ficou pela metade
 * porque a energia caiu.
 *
 * O polinômio é aplicado ao contrário (0xEDB88320 em vez de 0x04C11DB7)
 * porque a implementação processa os bits do menos significativo para o mais
 * significativo, que é o que deixa o laço curto. O resultado é idêntico ao do
 * `zlib.crc32`, e há um teste comparando com ele.
 */

/**
 * A tabela de 256 entradas.
 *
 * Sem ela o cálculo é bit a bit, oito vezes mais laço por byte. Com ela, um
 * byte vira uma busca e um XOR. É a otimização clássica de 1975 e continua
 * valendo.
 */
export const TABELA = (() => {
  const tabela = new Uint32Array(256);

  for (let i = 0; i < 256; i += 1) {
    let valor = i;

    for (let bit = 0; bit < 8; bit += 1) {
      valor = valor & 1 ? 0xedb88320 ^ (valor >>> 1) : valor >>> 1;
    }

    tabela[i] = valor >>> 0;
  }

  return tabela;
})();

/**
 * Calcula o CRC-32 de um buffer.
 *
 * O `anterior` permite calcular em pedaços: `crc32(b, crc32(a))` dá o mesmo
 * que `crc32(Buffer.concat([a, b]))`, o que importa quando o registro é
 * grande demais para segurar inteiro.
 */
export function crc32(bytes, anterior = 0) {
  let valor = (anterior ^ 0xffffffff) >>> 0;

  for (let i = 0; i < bytes.length; i += 1) {
    valor = (TABELA[(valor ^ bytes[i]) & 0xff] ^ (valor >>> 8)) >>> 0;
  }

  return (valor ^ 0xffffffff) >>> 0;
}

/** O CRC de um texto UTF-8. */
export function crc32Texto(texto) {
  return crc32(Buffer.from(texto, 'utf8'));
}
