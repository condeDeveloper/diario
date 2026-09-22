/**
 * Um chave-valor em cima do diário.
 *
 * É aqui que o desenho "só acrescenta" mostra a que veio. Gravar `a=1`,
 * depois `a=2`, depois apagar `a` escreve **três** registros; o valor atual é
 * simplesmente o último que apareceu.
 *
 * Isso parece desperdício e é o que dá:
 *
 * - escrita sempre sequencial, sem procurar onde a chave estava;
 * - histórico completo de graça, que é o que permite auditoria e viagem no
 *   tempo;
 * - recuperação trivial depois de uma queda, porque nada foi sobrescrito.
 *
 * O preço é o arquivo crescer para sempre — e a compactação é a resposta:
 * reescreve guardando só o último registro de cada chave. É exatamente o que
 * o Kafka chama de *log compaction* e o que um LSM-tree faz no *merge*.
 */

import { Diario } from './diario.js';

/** Marca que uma chave foi apagada. Sem ela, remover exigiria reescrever. */
export const APAGADO = Symbol('apagado');

/** Um registro do depósito, em JSON de uma linha. */
export function montarEntrada(chave, valor) {
  return Buffer.from(JSON.stringify(valor === APAGADO ? { c: chave, x: true } : { c: chave, v: valor }), 'utf8');
}

/** Lê um registro do depósito. */
export function lerEntrada(carga) {
  const entrada = JSON.parse(carga.toString('utf8'));

  return { chave: entrada.c, valor: entrada.x ? APAGADO : entrada.v };
}

/** Chave-valor durável, com histórico. */
export class Deposito {
  constructor(diario) {
    this.diario = diario;
    this.mapa = new Map();
  }

  /** Abre e reconstrói o estado lendo o diário do começo ao fim. */
  static async abrir(caminho, opcoes = {}) {
    const deposito = new Deposito(await Diario.abrir(caminho, opcoes));

    await deposito.recarregar();

    return deposito;
  }

  /** Refaz o mapa a partir do diário. */
  async recarregar() {
    this.mapa.clear();

    for (const carga of await this.diario.cargas()) {
      const { chave, valor } = lerEntrada(carga);

      // O último registro de cada chave é que vale — inclusive a remoção.
      if (valor === APAGADO) this.mapa.delete(chave);
      else this.mapa.set(chave, valor);
    }

    return this.mapa.size;
  }

  get tamanho() {
    return this.mapa.size;
  }

  obter(chave) {
    return this.mapa.get(chave);
  }

  tem(chave) {
    return this.mapa.has(chave);
  }

  chaves() {
    return [...this.mapa.keys()].sort();
  }

  /** Grava um valor. */
  async definir(chave, valor) {
    if (typeof chave !== 'string' || chave === '') throw new TypeError('A chave precisa ser um texto não vazio.');

    await this.diario.acrescentar(montarEntrada(chave, valor));
    this.mapa.set(chave, valor);

    return this;
  }

  /** Apaga uma chave gravando uma lápide. */
  async remover(chave) {
    if (!this.mapa.has(chave)) return false;

    await this.diario.acrescentar(montarEntrada(chave, APAGADO));
    this.mapa.delete(chave);

    return true;
  }

  /** O histórico de uma chave, do mais antigo para o mais novo. */
  async historico(chave) {
    const passos = [];

    for (const carga of await this.diario.cargas()) {
      const entrada = lerEntrada(carga);

      if (entrada.chave === chave) passos.push(entrada.valor);
    }

    return passos;
  }

  /**
   * Compacta guardando só o último registro de cada chave.
   *
   * A varredura é de trás para frente justamente para isso: o primeiro
   * registro encontrado para cada chave, indo ao contrário, é o que vale.
   */
  async compactar() {
    const registros = await this.diario.cargas();
    const vistas = new Set();
    const guardar = new Set();

    for (let i = registros.length - 1; i >= 0; i -= 1) {
      const { chave, valor } = lerEntrada(registros[i]);

      if (vistas.has(chave)) continue;

      vistas.add(chave);

      // Uma lápide só precisa continuar existindo se houver algo antes dela
      // para apagar — e, como tudo antes vai embora, ela também pode ir.
      if (valor !== APAGADO) guardar.add(i);
    }

    return this.diario.compactar((_carga, i) => guardar.has(i));
  }

  async fechar() {
    await this.diario.fechar();
  }
}
