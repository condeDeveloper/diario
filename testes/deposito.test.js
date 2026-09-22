import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { APAGADO, Deposito, lerEntrada, montarEntrada } from '../src/deposito.js';
import { Diario } from '../src/diario.js';
import { lerArgumentos, principal } from '../src/cli.js';

const temporarios = [];

async function arquivo(nome = 'kv.log') {
  const caminho = await mkdtemp(join(tmpdir(), 'diario-kv-'));

  temporarios.push(caminho);

  return join(caminho, nome);
}

/** Roda a CLI capturando a saída. */
async function rodar(...argumentos) {
  const linhas = [];
  const codigo = await principal(argumentos, (l) => linhas.push(String(l)));

  return { codigo, saida: linhas.join('\n') };
}

after(async () => {
  for (const caminho of temporarios) await rm(caminho, { recursive: true, force: true });
});

describe('a entrada', () => {
  it('vai e volta', () => {
    assert.deepEqual(lerEntrada(montarEntrada('a', 1)), { chave: 'a', valor: 1 });
    assert.deepEqual(lerEntrada(montarEntrada('a', { x: [1, 2] })), { chave: 'a', valor: { x: [1, 2] } });
  });

  it('a lápide é reconhecida', () => {
    assert.equal(lerEntrada(montarEntrada('a', APAGADO)).valor, APAGADO);
  });

  it('valor nulo é diferente de apagado', () => {
    assert.equal(lerEntrada(montarEntrada('a', null)).valor, null);
  });
});

describe('o depósito', () => {
  it('grava e lê', async () => {
    const deposito = await Deposito.abrir(await arquivo());

    try {
      await deposito.definir('nome', 'Ana');
      await deposito.definir('idade', 33);

      assert.equal(deposito.obter('nome'), 'Ana');
      assert.equal(deposito.obter('idade'), 33);
      assert.equal(deposito.tamanho, 2);
      assert.deepEqual(deposito.chaves(), ['idade', 'nome']);
    } finally {
      await deposito.fechar();
    }
  });

  it('o estado é reconstruído na abertura', async () => {
    const caminho = await arquivo();
    const primeiro = await Deposito.abrir(caminho);

    await primeiro.definir('a', 1);
    await primeiro.definir('a', 2);
    await primeiro.definir('b', 3);
    await primeiro.fechar();

    const segundo = await Deposito.abrir(caminho);

    try {
      // O valor atual é simplesmente o último registro da chave.
      assert.equal(segundo.obter('a'), 2);
      assert.equal(segundo.obter('b'), 3);
      assert.equal(segundo.tamanho, 2);
    } finally {
      await segundo.fechar();
    }
  });

  it('remover grava uma lápide e a remoção sobrevive a reabrir', async () => {
    const caminho = await arquivo();
    const primeiro = await Deposito.abrir(caminho);

    await primeiro.definir('a', 1);

    assert.equal(await primeiro.remover('a'), true);
    assert.equal(await primeiro.remover('a'), false);

    await primeiro.fechar();

    const segundo = await Deposito.abrir(caminho);

    try {
      assert.equal(segundo.tem('a'), false);
      assert.equal(segundo.tamanho, 0);
    } finally {
      await segundo.fechar();
    }
  });

  it('o histórico sai de graça, porque nada é sobrescrito', async () => {
    const deposito = await Deposito.abrir(await arquivo());

    try {
      await deposito.definir('preco', 1000);
      await deposito.definir('preco', 1200);
      await deposito.definir('preco', 990);

      assert.deepEqual(await deposito.historico('preco'), [1000, 1200, 990]);
      assert.deepEqual(await deposito.historico('nunca'), []);
    } finally {
      await deposito.fechar();
    }
  });

  it('a remoção aparece no histórico', async () => {
    const deposito = await Deposito.abrir(await arquivo());

    try {
      await deposito.definir('a', 1);
      await deposito.remover('a');

      const passos = await deposito.historico('a');

      assert.equal(passos.length, 2);
      assert.equal(passos[1], APAGADO);
    } finally {
      await deposito.fechar();
    }
  });

  it('chave inválida é recusada', async () => {
    const deposito = await Deposito.abrir(await arquivo());

    try {
      await assert.rejects(() => deposito.definir('', 1), TypeError);
      await assert.rejects(() => deposito.definir(7, 1), /texto não vazio/);
    } finally {
      await deposito.fechar();
    }
  });
});

describe('compactação do depósito', () => {
  it('guarda só o último de cada chave', async () => {
    const caminho = await arquivo();
    const deposito = await Deposito.abrir(caminho);

    try {
      for (let i = 0; i < 50; i += 1) await deposito.definir('contador', i);

      await deposito.definir('outra', 'x');

      const antes = (await stat(caminho)).size;
      const resultado = await deposito.compactar();

      assert.equal(resultado.antes, 51);
      assert.equal(resultado.depois, 2);
      assert.ok((await stat(caminho)).size < antes);

      // O estado continua exatamente o mesmo depois de encolher.
      assert.equal(deposito.obter('contador'), 49);
      assert.equal(deposito.obter('outra'), 'x');
    } finally {
      await deposito.fechar();
    }
  });

  it('a chave apagada some de vez, com a lápide junto', async () => {
    const caminho = await arquivo();
    const deposito = await Deposito.abrir(caminho);

    await deposito.definir('vai', 1);
    await deposito.definir('fica', 2);
    await deposito.remover('vai');
    await deposito.compactar();
    await deposito.fechar();

    const reaberto = await Deposito.abrir(caminho);

    try {
      assert.deepEqual(reaberto.chaves(), ['fica']);
      assert.deepEqual(await reaberto.historico('vai'), []);
    } finally {
      await reaberto.fechar();
    }
  });

  it('compactar e reabrir dá o mesmo estado', async () => {
    const caminho = await arquivo();
    const deposito = await Deposito.abrir(caminho);

    await deposito.definir('a', 1);
    await deposito.definir('b', 2);
    await deposito.definir('a', 3);
    await deposito.remover('b');
    await deposito.definir('c', 4);

    const antes = deposito.chaves().map((c) => [c, deposito.obter(c)]);

    await deposito.compactar();
    await deposito.fechar();

    const reaberto = await Deposito.abrir(caminho);

    try {
      assert.deepEqual(reaberto.chaves().map((c) => [c, reaberto.obter(c)]), antes);
    } finally {
      await reaberto.fechar();
    }
  });
});

describe('linha de comando', () => {
  it('lê os argumentos', () => {
    assert.deepEqual(lerArgumentos(['ler', 'a.log']).comando, 'ler');

    const kv = lerArgumentos(['kv', 'definir', 'a.log', 'chave', 'valor']);

    assert.equal(kv.comando, 'kv');
    assert.equal(kv.acao, 'definir');
    assert.equal(kv.chave, 'chave');
    assert.equal(kv.valor, 'valor');
  });

  it('recusa opção desconhecida', () => {
    assert.throws(() => lerArgumentos(['--inventada']), /desconhecida/);
  });

  it('acrescenta, lê e confere', async () => {
    const caminho = await arquivo('cli.log');

    assert.match((await rodar('acrescentar', caminho, 'primeiro')).saida, /gravado em 0/);
    await rodar('acrescentar', caminho, 'segundo');

    const lido = await rodar('ler', caminho);

    assert.equal(lido.codigo, 0);
    assert.match(lido.saida, /primeiro/);
    assert.match(lido.saida, /segundo/);

    assert.match((await rodar('conferir', caminho)).saida, /2 registro\(s\) íntegro\(s\)/);
  });

  it('o chave-valor funciona pela linha de comando', async () => {
    const caminho = await arquivo('cli-kv.log');

    assert.equal((await rodar('kv', 'definir', caminho, 'nome', 'Ana')).codigo, 0);
    await rodar('kv', 'definir', caminho, 'nome', 'Ana Souza');

    assert.equal((await rodar('kv', 'obter', caminho, 'nome')).saida, '"Ana Souza"');
    assert.match((await rodar('kv', 'listar', caminho)).saida, /nome = "Ana Souza"/);
    assert.match((await rodar('kv', 'historico', caminho, 'nome')).saida, /1\. "Ana"[\s\S]*2\. "Ana Souza"/);

    assert.match((await rodar('kv', 'remover', caminho, 'nome')).saida, /removida/);
    assert.equal((await rodar('kv', 'obter', caminho, 'nome')).codigo, 1);
  });

  it('kv compactar guarda só o último de cada chave', async () => {
    const caminho = await arquivo('cli-comp.log');

    for (let i = 0; i < 10; i += 1) await rodar('kv', 'definir', caminho, 'a', String(i));

    assert.match((await rodar('kv', 'compactar', caminho)).saida, /10 → 1 registro/);
  });

  it('argumentos faltando saem com 2', async () => {
    const caminho = await arquivo('cli-erro.log');

    assert.equal((await rodar()).codigo, 2);
    assert.equal((await rodar('voar', caminho)).codigo, 2);
    assert.equal((await rodar('conferir')).codigo, 2);
    assert.equal((await rodar('acrescentar', caminho)).codigo, 2);
    assert.equal((await rodar('kv', 'obter', caminho)).codigo, 2);
    assert.equal((await rodar('kv', 'definir', caminho, 'a')).codigo, 2);
    assert.equal((await rodar('kv', 'voar', caminho, 'a')).codigo, 2);
  });

  it('a ajuda sai com 0', async () => {
    const { codigo, saida } = await rodar('--ajuda');

    assert.equal(codigo, 0);
    assert.match(saida, /log append-only/);
  });

  it('histórico de chave que nunca existiu é dito com todas as letras', async () => {
    const caminho = await arquivo('cli-vazio.log');

    await new Diario(caminho);

    assert.match((await rodar('kv', 'historico', caminho, 'fantasma')).saida, /nunca existiu/);
  });
});
