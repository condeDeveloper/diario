/**
 * Escreve registros e morre no meio de um deles.
 *
 * Usado pelo teste de recuperação. É a única forma honesta de produzir um
 * arquivo com meio registro no fim: um processo de verdade, escrevendo de
 * verdade, morto de verdade. Truncar o arquivo depois com `truncate` testaria
 * o `truncate`, não a recuperação.
 *
 *   node escrever-e-morrer.js <arquivo> <quantos-inteiros> <bytes-do-ultimo>
 */

import { open } from 'node:fs/promises';

import { montar } from '../../src/registro.js';

const [caminho, quantos, pedaco] = process.argv.slice(2);
const arquivo = await open(caminho, 'a');

for (let i = 0; i < Number(quantos); i += 1) {
  await arquivo.write(montar(`registro ${i}`));
}

const incompleto = montar('este nunca vai ficar inteiro');

await arquivo.write(incompleto.subarray(0, Number(pedaco)));
await arquivo.sync();

// `exit` sem fechar nada, com um código que não é zero: é o mais perto de uma
// queda de energia que dá para simular sem desligar a máquina.
process.exit(9);
