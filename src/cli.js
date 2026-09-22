#!/usr/bin/env node
/**
 * A linha de comando.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Diario } from './diario.js';
import { Deposito } from './deposito.js';

const AJUDA = `diario — log append-only com CRC32 e recuperação de queda

  diario conferir <arquivo>            varre e diz o que sobrou de íntegro
  diario ler <arquivo>                 mostra os registros
  diario acrescentar <arquivo> <texto> grava um registro
  diario compactar <arquivo>           reescreve o arquivo do zero

  kv definir <arquivo> <chave> <valor>
  kv obter <arquivo> <chave>
  kv remover <arquivo> <chave>
  kv listar <arquivo>
  kv historico <arquivo> <chave>
  kv compactar <arquivo>               guarda só o último registro de cada chave

  -h, --ajuda`;

/** Lê os argumentos. */
export function lerArgumentos(argumentos) {
  const opcoes = { comando: null, acao: null, arquivo: null, chave: null, valor: null, ajuda: false };
  const soltos = [];

  for (const arg of argumentos) {
    if (arg === '-h' || arg === '--ajuda') opcoes.ajuda = true;
    else if (arg.startsWith('-')) throw new Error(`Opção desconhecida: ${arg}.`);
    else soltos.push(arg);
  }

  if (soltos[0] === 'kv') {
    [, opcoes.acao = null, opcoes.arquivo = null, opcoes.chave = null, opcoes.valor = null] = soltos;
    opcoes.comando = 'kv';
  } else {
    [opcoes.comando = null, opcoes.arquivo = null, opcoes.valor = null] = soltos;
  }

  return opcoes;
}

/** Roda um comando e devolve o código de saída. */
export async function principal(argumentos, escrever = console.log) {
  let opcoes;

  try {
    opcoes = lerArgumentos(argumentos);
  } catch (erro) {
    escrever(erro.message);
    return 2;
  }

  if (opcoes.ajuda || opcoes.comando === null) {
    escrever(AJUDA);
    return opcoes.ajuda ? 0 : 2;
  }

  const conhecidos = ['conferir', 'ler', 'acrescentar', 'compactar', 'kv'];

  if (!conhecidos.includes(opcoes.comando)) {
    escrever(`Comando desconhecido: ${opcoes.comando}.\n\n${AJUDA}`);
    return 2;
  }

  if (opcoes.arquivo === null) {
    escrever('Informe o arquivo.');
    return 2;
  }

  try {
    return opcoes.comando === 'kv' ? await chaveValor(opcoes, escrever) : await direto(opcoes, escrever);
  } catch (erro) {
    escrever(erro.message);
    return 1;
  }
}

async function direto(opcoes, escrever) {
  const diario = await Diario.abrir(opcoes.arquivo);

  try {
    if (opcoes.comando === 'conferir') {
      const { recuperados, descartados, motivo } = diario.recuperacao ?? { recuperados: 0, descartados: 0, motivo: 'vazio' };

      escrever(`${recuperados} registro(s) íntegro(s), ${diario.tamanho} bytes.`);

      if (descartados > 0) {
        escrever(`  ${descartados} byte(s) no fim descartados (${motivo}) — o arquivo foi cortado.`);
      }

      return 0;
    }

    if (opcoes.comando === 'ler') {
      for (const { deslocamento, carga } of await diario.ler()) {
        escrever(`${String(deslocamento).padStart(8)}  ${carga.toString('utf8')}`);
      }

      return 0;
    }

    if (opcoes.comando === 'acrescentar') {
      if (opcoes.valor === null) {
        escrever('Informe o texto do registro.');
        return 2;
      }

      const { deslocamento, bytes } = await diario.acrescentar(opcoes.valor);

      escrever(`gravado em ${deslocamento} (${bytes} bytes).`);

      return 0;
    }

    const { antes, depois, bytes } = await diario.compactar();

    escrever(`${antes} → ${depois} registro(s), ${bytes} bytes.`);

    return 0;
  } finally {
    await diario.fechar();
  }
}

async function chaveValor(opcoes, escrever) {
  const deposito = await Deposito.abrir(opcoes.arquivo);

  try {
    if (opcoes.acao === 'compactar') {
      const { antes, depois, bytes } = await deposito.compactar();

      escrever(`${antes} → ${depois} registro(s), ${bytes} bytes.`);

      return 0;
    }

    if (opcoes.acao === 'listar') {
      for (const chave of deposito.chaves()) escrever(`${chave} = ${JSON.stringify(deposito.obter(chave))}`);

      return 0;
    }

    if (opcoes.chave === null) {
      escrever('Informe a chave.');
      return 2;
    }

    if (opcoes.acao === 'obter') {
      if (!deposito.tem(opcoes.chave)) {
        escrever(`${opcoes.chave}: não existe`);
        return 1;
      }

      escrever(JSON.stringify(deposito.obter(opcoes.chave)));

      return 0;
    }

    if (opcoes.acao === 'definir') {
      if (opcoes.valor === null) {
        escrever('Informe o valor.');
        return 2;
      }

      await deposito.definir(opcoes.chave, opcoes.valor);
      escrever(`${opcoes.chave} = ${JSON.stringify(opcoes.valor)}`);

      return 0;
    }

    if (opcoes.acao === 'remover') {
      escrever(await deposito.remover(opcoes.chave) ? 'removida' : 'não existia');

      return 0;
    }

    if (opcoes.acao === 'historico') {
      const passos = await deposito.historico(opcoes.chave);

      // O histórico sai de graça: como nada é sobrescrito, ele já está lá.
      for (const [i, valor] of passos.entries()) {
        escrever(`${String(i + 1).padStart(3)}. ${typeof valor === 'symbol' ? '(apagada)' : JSON.stringify(valor)}`);
      }

      if (passos.length === 0) escrever(`${opcoes.chave}: nunca existiu`);

      return 0;
    }

    escrever(`Ação desconhecida: ${opcoes.acao}.\n\n${AJUDA}`);

    return 2;
  } finally {
    await deposito.fechar();
  }
}

/* c8 ignore start */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  principal(process.argv.slice(2)).then((codigo) => {
    process.exitCode = codigo;
  });
}
/* c8 ignore stop */
