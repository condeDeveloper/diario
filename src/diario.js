/**
 * O diário: um arquivo que só cresce pelo fim.
 *
 * É o desenho por trás do WAL do Postgres, do commit log do Kafka e do journal
 * de um sistema de arquivos. A ideia cabe numa frase: **nunca mexa no que já
 * está escrito; só acrescente no fim**. Daí sai quase tudo:
 *
 * - Escrita sequencial, que é o padrão de acesso mais rápido que existe em
 *   disco rotativo e continua sendo o mais amigável em SSD.
 * - Não há como corromper dado antigo, porque ninguém escreve por cima dele.
 * - Uma queda no meio da escrita estraga **só o último registro**, e o
 *   próximo `abrir` corta o pedaço quebrado.
 *
 * O preço é que o arquivo cresce para sempre, e é por isso que existe
 * compactação.
 */

import { existsSync } from 'node:fs';
import { open, readFile, rename, rm, stat, truncate } from 'node:fs/promises';

import { CABECALHO, ErroDeRegistro, montar, varrer } from './registro.js';

/** Um diário aberto. */
export class Diario {
  constructor(caminho, { sincronizarSempre = false } = {}) {
    this.caminho = caminho;
    this.sincronizarSempre = sincronizarSempre;
    this.arquivo = null;
    this.tamanho = 0;
    this.quantidade = 0;
    this.recuperacao = null;
  }

  /**
   * Abre o diário, recuperando o que sobrou de uma queda.
   *
   * Esta é a parte que justifica o formato: se o último registro está pela
   * metade, o arquivo é **cortado** no fim do último registro íntegro. Não há
   * conserto a fazer e não há dado antigo em risco.
   */
  static async abrir(caminho, opcoes = {}) {
    const diario = new Diario(caminho, opcoes);

    if (existsSync(caminho)) {
      const bytes = await readFile(caminho);
      const varredura = varrer(bytes);

      diario.quantidade = varredura.registros.length;
      diario.tamanho = varredura.valido;
      diario.recuperacao = {
        recuperados: varredura.registros.length,
        descartados: varredura.sobra,
        motivo: varredura.motivo,
      };

      if (varredura.sobra > 0) await truncate(caminho, varredura.valido);
    }

    diario.arquivo = await open(caminho, 'a');

    return diario;
  }

  /** Grava um registro e devolve onde ele ficou. */
  async acrescentar(carga) {
    this.exigirAberto();

    const bytes = montar(carga);
    const deslocamento = this.tamanho;

    await this.arquivo.write(bytes);

    this.tamanho += bytes.length;
    this.quantidade += 1;

    // `write` só entrega ao sistema operacional; os bytes podem ficar em
    // cache por segundos. Quem precisa sobreviver a uma queda de energia — e
    // não só ao fim do processo — tem que pagar o fsync.
    if (this.sincronizarSempre) await this.arquivo.sync();

    return { deslocamento, bytes: bytes.length };
  }

  /** Grava vários de uma vez, com um fsync só no fim. */
  async acrescentarVarios(cargas) {
    this.exigirAberto();

    const bytes = Buffer.concat(cargas.map((c) => montar(c)));
    const deslocamento = this.tamanho;

    await this.arquivo.write(bytes);

    this.tamanho += bytes.length;
    this.quantidade += cargas.length;

    if (this.sincronizarSempre) await this.arquivo.sync();

    return { deslocamento, bytes: bytes.length, registros: cargas.length };
  }

  /** Força os bytes para o disco. */
  async sincronizar() {
    this.exigirAberto();

    await this.arquivo.sync();
  }

  /** Lê todos os registros. */
  async ler() {
    const bytes = await readFile(this.caminho);

    return varrer(bytes).registros;
  }

  /** Só as cargas, que é o que quase sempre se quer. */
  async cargas() {
    return (await this.ler()).map((r) => r.carga);
  }

  /**
   * Reescreve o diário mantendo só o que o filtro aprovar.
   *
   * A troca é atômica: escreve num arquivo ao lado e renomeia. Se a energia
   * cair no meio, o original continua inteiro — `rename` sobre o mesmo
   * sistema de arquivos ou acontece por completo ou não acontece.
   *
   * @param {(carga: Buffer, indice: number) => boolean} manter
   */
  async compactar(manter = () => true) {
    this.exigirAberto();

    const registros = await this.ler();
    const guardados = registros.map((r) => r.carga).filter((carga, i) => manter(carga, i));
    const temporario = `${this.caminho}.novo`;

    const destino = await open(temporario, 'w');

    try {
      if (guardados.length > 0) await destino.write(Buffer.concat(guardados.map((c) => montar(c))));

      // O fsync vem antes do rename: renomear um arquivo cujo conteúdo ainda
      // está em cache troca um arquivo bom por um vazio se a energia cair.
      await destino.sync();
    } finally {
      await destino.close();
    }

    await this.arquivo.close();
    await rename(temporario, this.caminho);

    this.arquivo = await open(this.caminho, 'a');
    this.quantidade = guardados.length;
    this.tamanho = guardados.reduce((total, c) => total + CABECALHO + c.length, 0);

    return { antes: registros.length, depois: guardados.length, bytes: this.tamanho };
  }

  /** Apaga tudo. */
  async esvaziar() {
    this.exigirAberto();

    await this.arquivo.close();
    await rm(this.caminho, { force: true });

    this.arquivo = await open(this.caminho, 'a');
    this.tamanho = 0;
    this.quantidade = 0;
  }

  /** Tamanho real em disco, para comparar com o que a instância acha. */
  async tamanhoEmDisco() {
    return existsSync(this.caminho) ? (await stat(this.caminho)).size : 0;
  }

  async fechar() {
    if (this.arquivo === null) return;

    await this.arquivo.close();
    this.arquivo = null;
  }

  exigirAberto() {
    if (this.arquivo === null) throw new ErroDeRegistro('O diário está fechado.');
  }
}
