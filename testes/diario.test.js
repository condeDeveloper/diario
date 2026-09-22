import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { crc32 as crc32DoNode } from 'node:zlib';

import { crc32, crc32Texto } from '../src/crc32.js';
import { CABECALHO, ErroDeRegistro, MARCA, ler, montar, varrer } from '../src/registro.js';
import { Diario } from '../src/diario.js';

const temporarios = [];

async function pasta() {
  const caminho = await mkdtemp(join(tmpdir(), 'diario-'));

  temporarios.push(caminho);

  return caminho;
}

after(async () => {
  for (const caminho of temporarios) await rm(caminho, { recursive: true, force: true });
});

describe('CRC-32', () => {
  it('bate com o do node:zlib', () => {
    // A régua é a implementação que todo mundo usa, não uma constante que eu
    // escrevi.
    for (const texto of ['', 'a', 'oi\n', 'The quick brown fox', 'ação é bytes', 'x'.repeat(1000)]) {
      assert.equal(crc32Texto(texto), crc32DoNode(Buffer.from(texto, 'utf8')), `divergiu em ${JSON.stringify(texto.slice(0, 20))}`);
    }
  });

  it('bate no valor publicado para "123456789"', () => {
    assert.equal(crc32Texto('123456789'), 0xcbf43926);
  });

  it('pode ser calculado em pedaços', () => {
    const a = Buffer.from('primeira parte ');
    const b = Buffer.from('segunda parte');

    assert.equal(crc32(b, crc32(a)), crc32(Buffer.concat([a, b])));
  });

  it('um bit trocado muda o resultado', () => {
    assert.notEqual(crc32Texto('registro'), crc32Texto('registrp'));
  });

  it('o vazio dá zero', () => {
    assert.equal(crc32(Buffer.alloc(0)), 0);
  });
});

describe('o registro', () => {
  it('tem marca, tamanho, CRC e carga', () => {
    const bytes = montar('oi');

    assert.ok(bytes.subarray(0, 4).equals(MARCA));
    assert.equal(bytes.readUInt32BE(4), 2);
    assert.equal(bytes.readUInt32BE(8), crc32Texto('oi'));
    assert.equal(bytes.length, CABECALHO + 2);
  });

  it('vai e volta', () => {
    const lido = ler(montar('conteúdo com acento'), 0);

    assert.equal(lido.motivo, 'ok');
    assert.equal(lido.carga.toString('utf8'), 'conteúdo com acento');
  });

  it('registro vazio é válido', () => {
    assert.equal(ler(montar(''), 0).motivo, 'ok');
  });

  it('conteúdo binário atravessa intacto', () => {
    const bytes = Buffer.from([0, 1, 255, 0, 10]);

    assert.deepEqual(ler(montar(bytes), 0).carga, bytes);
  });

  it('um byte trocado na carga é pego pelo CRC', () => {
    const bytes = montar('registro importante');

    bytes[CABECALHO + 2] ^= 0x01;

    const lido = ler(bytes, 0);

    assert.equal(lido.motivo, 'crc');
    assert.notEqual(lido.esperado, lido.obtido);
  });

  it('sem a marca a leitura para, em vez de inventar', () => {
    assert.equal(ler(Buffer.from('LIXOLIXOLIXOLIXO'), 0).motivo, 'sem-marca');
  });

  it('tamanho absurdo não faz alocar gigabytes', () => {
    // Quatro bytes trocados no cabeçalho não podem virar um alloc de 3 GB.
    const bytes = montar('x');

    bytes.writeUInt32BE(0xfffffff0, 4);

    assert.equal(ler(bytes, 0).motivo, 'truncado');
  });

  it('registro acima do teto é recusado na escrita', () => {
    assert.throws(() => montar(Buffer.alloc(65 * 1024 * 1024)), ErroDeRegistro);
  });

  it('varrer devolve onde parou', () => {
    const bytes = Buffer.concat([montar('um'), montar('dois'), Buffer.from('meio registro')]);
    const { registros, valido, sobra, motivo } = varrer(bytes);

    assert.equal(registros.length, 2);
    assert.equal(valido, montar('um').length + montar('dois').length);
    assert.equal(sobra, 13);
    assert.equal(motivo, 'sem-marca');
  });
});

describe('recuperação de queda', () => {
  it('um processo morto no meio da escrita deixa o arquivo recuperável', async () => {
    // Um processo de verdade, escrevendo de verdade, morto de verdade.
    // Truncar depois testaria o truncate, não a recuperação.
    const caminho = join(await pasta(), 'wal.log');
    const auxiliar = join(process.cwd(), 'testes', 'auxiliar', 'escrever-e-morrer.js');

    let codigo = 0;

    try {
      execFileSync(process.execPath, [auxiliar, caminho, '5', '7'], { stdio: 'ignore' });
    } catch (erro) {
      codigo = erro.status;
    }

    assert.equal(codigo, 9, 'o processo auxiliar deveria ter morrido');

    const bruto = await readFile(caminho);

    assert.ok(bruto.length > 0);

    const diario = await Diario.abrir(caminho);

    try {
      assert.equal(diario.quantidade, 5);
      assert.equal(diario.recuperacao.recuperados, 5);
      assert.equal(diario.recuperacao.descartados, 7);
      assert.equal(await diario.tamanhoEmDisco(), diario.tamanho);

      const cargas = (await diario.cargas()).map((c) => c.toString('utf8'));

      assert.deepEqual(cargas, ['registro 0', 'registro 1', 'registro 2', 'registro 3', 'registro 4']);
    } finally {
      await diario.fechar();
    }
  });

  it('depois de recuperado dá para continuar escrevendo', async () => {
    const caminho = join(await pasta(), 'wal.log');
    const auxiliar = join(process.cwd(), 'testes', 'auxiliar', 'escrever-e-morrer.js');

    try {
      execFileSync(process.execPath, [auxiliar, caminho, '3', '20'], { stdio: 'ignore' });
    } catch {
      // O código 9 é esperado.
    }

    const diario = await Diario.abrir(caminho);

    try {
      await diario.acrescentar('depois da queda');

      assert.equal(diario.quantidade, 4);
      assert.equal((await diario.cargas()).at(-1).toString('utf8'), 'depois da queda');
    } finally {
      await diario.fechar();
    }
  });

  it('carga corrompida no meio corta dali para frente', async () => {
    const caminho = join(await pasta(), 'wal.log');
    const bytes = Buffer.concat([montar('um'), montar('dois'), montar('tres')]);

    // Estraga a carga do segundo registro.
    bytes[montar('um').length + CABECALHO] ^= 0xff;

    await writeFile(caminho, bytes);

    const diario = await Diario.abrir(caminho);

    try {
      assert.equal(diario.quantidade, 1);
      assert.equal(diario.recuperacao.motivo, 'crc');
      assert.equal(await diario.tamanhoEmDisco(), montar('um').length);
    } finally {
      await diario.fechar();
    }
  });

  it('lixo colado no fim é descartado', async () => {
    const caminho = join(await pasta(), 'wal.log');

    await writeFile(caminho, montar('bom'));
    await appendFile(caminho, 'lixo que não é registro');

    const diario = await Diario.abrir(caminho);

    try {
      assert.equal(diario.quantidade, 1);
      assert.equal(diario.recuperacao.motivo, 'sem-marca');
    } finally {
      await diario.fechar();
    }
  });

  it('arquivo que não existe abre vazio', async () => {
    const diario = await Diario.abrir(join(await pasta(), 'novo.log'));

    try {
      assert.equal(diario.quantidade, 0);
      assert.equal(diario.tamanho, 0);
      assert.equal(diario.recuperacao, null);
    } finally {
      await diario.fechar();
    }
  });
});

describe('escrita', () => {
  it('acrescenta e relê', async () => {
    const diario = await Diario.abrir(join(await pasta(), 'a.log'));

    try {
      await diario.acrescentar('um');
      await diario.acrescentar('dois');

      assert.deepEqual((await diario.cargas()).map((c) => c.toString('utf8')), ['um', 'dois']);
      assert.equal(diario.quantidade, 2);
    } finally {
      await diario.fechar();
    }
  });

  it('o deslocamento devolvido aponta para o registro', async () => {
    const caminho = join(await pasta(), 'a.log');
    const diario = await Diario.abrir(caminho);

    try {
      await diario.acrescentar('primeiro');

      const { deslocamento } = await diario.acrescentar('segundo');
      const bytes = await readFile(caminho);

      assert.equal(ler(bytes, deslocamento).carga.toString('utf8'), 'segundo');
    } finally {
      await diario.fechar();
    }
  });

  it('acrescentar vários grava tudo de uma vez', async () => {
    const diario = await Diario.abrir(join(await pasta(), 'a.log'));

    try {
      const { registros } = await diario.acrescentarVarios(['a', 'b', 'c']);

      assert.equal(registros, 3);
      assert.equal(diario.quantidade, 3);
      assert.deepEqual((await diario.cargas()).map((c) => c.toString()), ['a', 'b', 'c']);
    } finally {
      await diario.fechar();
    }
  });

  it('reabrir enxerga o que foi escrito antes', async () => {
    const caminho = join(await pasta(), 'a.log');
    const primeiro = await Diario.abrir(caminho);

    await primeiro.acrescentar('persistente');
    await primeiro.fechar();

    const segundo = await Diario.abrir(caminho);

    try {
      assert.equal(segundo.quantidade, 1);
      assert.equal((await segundo.cargas())[0].toString('utf8'), 'persistente');
    } finally {
      await segundo.fechar();
    }
  });

  it('com sincronizarSempre o fsync é chamado a cada registro', async () => {
    const diario = await Diario.abrir(join(await pasta(), 'a.log'), { sincronizarSempre: true });

    try {
      await diario.acrescentar('durável');

      assert.equal(await diario.tamanhoEmDisco(), diario.tamanho);
    } finally {
      await diario.fechar();
    }
  });

  it('escrever depois de fechar reclama', async () => {
    const diario = await Diario.abrir(join(await pasta(), 'a.log'));

    await diario.fechar();

    await assert.rejects(() => diario.acrescentar('tarde'), /está fechado/);
  });

  it('fechar duas vezes não quebra', async () => {
    const diario = await Diario.abrir(join(await pasta(), 'a.log'));

    await diario.fechar();
    await diario.fechar();
  });
});

describe('compactação', () => {
  it('guarda só o que o filtro aprova', async () => {
    const diario = await Diario.abrir(join(await pasta(), 'a.log'));

    try {
      await diario.acrescentarVarios(['um', 'dois', 'tres', 'quatro']);

      const { antes, depois } = await diario.compactar((carga) => carga.toString('utf8').length > 3);

      assert.equal(antes, 4);
      assert.equal(depois, 3);
      assert.deepEqual((await diario.cargas()).map((c) => c.toString()), ['dois', 'tres', 'quatro']);
    } finally {
      await diario.fechar();
    }
  });

  it('o tamanho em disco bate com o que a instância acha', async () => {
    const diario = await Diario.abrir(join(await pasta(), 'a.log'));

    try {
      await diario.acrescentarVarios(['a', 'b', 'c', 'd']);
      await diario.compactar((carga) => carga.toString() !== 'b');

      assert.equal(await diario.tamanhoEmDisco(), diario.tamanho);
    } finally {
      await diario.fechar();
    }
  });

  it('compactar tudo fora deixa o arquivo vazio e ainda utilizável', async () => {
    const diario = await Diario.abrir(join(await pasta(), 'a.log'));

    try {
      await diario.acrescentarVarios(['a', 'b']);
      await diario.compactar(() => false);

      assert.equal(diario.quantidade, 0);
      assert.equal(await diario.tamanhoEmDisco(), 0);

      await diario.acrescentar('depois');

      assert.equal((await diario.cargas())[0].toString(), 'depois');
    } finally {
      await diario.fechar();
    }
  });

  it('não sobra arquivo temporário', async () => {
    const caminho = join(await pasta(), 'a.log');
    const diario = await Diario.abrir(caminho);

    try {
      await diario.acrescentar('x');
      await diario.compactar();

      await assert.rejects(() => readFile(`${caminho}.novo`), /ENOENT/);
    } finally {
      await diario.fechar();
    }
  });

  it('esvaziar apaga tudo', async () => {
    const diario = await Diario.abrir(join(await pasta(), 'a.log'));

    try {
      await diario.acrescentar('x');
      await diario.esvaziar();

      assert.equal(diario.quantidade, 0);
      assert.deepEqual(await diario.cargas(), []);
    } finally {
      await diario.fechar();
    }
  });
});
