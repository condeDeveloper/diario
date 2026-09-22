# diario

Um log *append-only* com CRC-32, compactação e recuperação de queda no meio da
escrita — e um chave-valor durável construído em cima dele. **Zero
dependências.**

```bash
$ kv definir pedidos.log preco 1000
$ kv definir pedidos.log preco 1200
$ kv definir pedidos.log preco 990

$ kv historico pedidos.log preco
  1. "1000"
  2. "1200"
  3. "990"

$ kv compactar pedidos.log
4 → 2 registro(s), 71 bytes.

$ kv listar pedidos.log
estoque = "42"
preco = "990"
```

E o que acontece quando um processo morre no meio de uma escrita:

```bash
$ node escrever-e-morrer.js wal.log 4 9    # escreve 4 e morre no quinto
(o processo morreu com 9)

$ diario conferir wal.log
4 registro(s) íntegro(s), 88 bytes.
  9 byte(s) no fim descartados (truncado) — o arquivo foi cortado.

$ diario ler wal.log
       0  registro 0
      22  registro 1
      44  registro 2
      66  registro 3
```

## Por que existe

É o desenho por trás do WAL do Postgres, do commit log do Kafka, do journal de
um sistema de arquivos e de todo LSM-tree. A ideia cabe numa frase — **nunca
mexa no que já está escrito; só acrescente no fim** — e dela sai praticamente
tudo o que esses sistemas conseguem fazer.

### 1. Uma queda estraga no máximo o último registro

Se ninguém escreve por cima do que já está lá, dado antigo não corre risco. A
energia caindo no meio de uma gravação deixa **meio registro no fim**, e mais
nada. O `abrir` varre desde o começo, acha onde a integridade termina e corta
o arquivo ali. Não há conserto a fazer.

Esse é o teste mais importante do projeto, e ele não simula nada: um processo
de verdade escreve, escreve e morre com `process.exit(9)` no meio de um
registro. Truncar o arquivo depois com `truncate` testaria o `truncate`.

### 2. O CRC não é segurança

Quem quiser forjar um registro recalcula o CRC em dois segundos. Ele está lá
para pegar **corrupção acidental**: o setor que veio meio gravado, o byte que
o disco trocou, o registro interrompido. Bate com o `zlib.crc32` — há um teste
comparando os dois.

### 3. A marca no começo de cada registro

Parece redundante num arquivo que só tem registros. Não é: depois de uma
queda, o que sobra no fim são bytes soltos, e a marca é o que permite dizer
"daqui para frente não é registro meu" com certeza — em vez de interpretar
quatro bytes de lixo como um tamanho de 3 GB e tentar alocar. Há um teste
exatamente para isso.

### 4. `write` não é durável

```js
await arquivo.write(bytes);   // entregou ao sistema operacional
await arquivo.sync();         // agora, sim, está no disco
```

Entre um e outro os bytes podem ficar em cache por segundos. Sobreviver ao fim
do processo é grátis; sobreviver a uma queda de energia custa um `fsync`, e
`sincronizarSempre: true` paga esse preço a cada registro.

### 5. Escrever três vezes a mesma chave é uma virtude

No chave-valor aqui em cima, gravar `a=1`, `a=2` e apagar `a` escreve **três**
registros. O valor atual é simplesmente o último que apareceu. Isso parece
desperdício e dá três coisas:

- escrita sempre sequencial, sem procurar onde a chave estava;
- **histórico completo de graça** — `kv historico` não precisou ser
  implementado, ele já estava lá;
- recuperação trivial, porque nada foi sobrescrito.

O preço é o arquivo crescer para sempre, e a resposta é a compactação:
reescrever guardando só o último registro de cada chave. É o que o Kafka chama
de *log compaction* e o que um LSM-tree faz no *merge*.

A troca é atômica — escreve ao lado, faz `fsync` e **só então** renomeia. Um
`rename` no mesmo sistema de arquivos ou acontece por completo ou não
acontece; renomear antes do `fsync` trocaria um arquivo bom por um vazio se a
energia caísse no meio.

## O formato

```
'DIA1'      4 bytes — marca
tamanho     4 bytes — tamanho da carga
crc         4 bytes — CRC-32 da carga
carga       <tamanho> bytes
```

## A API

```js
import { Diario, Deposito } from 'diario';

const diario = await Diario.abrir('wal.log', { sincronizarSempre: true });

await diario.acrescentar('um evento');
await diario.acrescentarVarios(['vários', 'de', 'uma vez']);

diario.recuperacao;  // { recuperados, descartados, motivo } — o que a abertura achou

await diario.compactar((carga, i) => manter(carga));

// O chave-valor em cima:
const deposito = await Deposito.abrir('kv.log');

await deposito.definir('preco', 990);
deposito.obter('preco');
await deposito.historico('preco');   // [1000, 1200, 990]
await deposito.compactar();          // guarda só o último de cada chave
```

## Linha de comando

```
diario conferir <arquivo>            varre e diz o que sobrou de íntegro
diario ler <arquivo>                 mostra os registros
diario acrescentar <arquivo> <texto> grava um registro
diario compactar <arquivo>           reescreve o arquivo do zero

kv definir <arquivo> <chave> <valor>
kv obter | remover | historico <arquivo> <chave>
kv listar <arquivo>
kv compactar <arquivo>               guarda só o último registro de cada chave
```

## Estrutura

```
src/crc32.js     a tabela de 256 entradas e o cálculo
src/registro.js  marca, tamanho, CRC e a varredura que acha onde parar
src/diario.js    abrir com recuperação, acrescentar, fsync, compactar
src/deposito.js  chave-valor com lápide, histórico e compactação por chave
src/cli.js       diario e kv
```

## Rodando

```bash
npm test
```

51 testes. O de recuperação roda um processo auxiliar de verdade
(`testes/auxiliar/escrever-e-morrer.js`), que escreve alguns registros, grava
um pedaço do próximo e morre. Os outros cobrem CRC contra o `zlib`, corrupção
no meio do arquivo, lixo colado no fim, tamanho absurdo no cabeçalho e a
atomicidade da compactação.

Node 20 ou mais novo.

## Limites conhecidos

- **Lê o arquivo inteiro na memória** para varrer e para compactar. Um log de
  vários GB não cabe; a solução seria varrer em blocos, que é o que um banco
  de verdade faz.
- **Sem índice.** `obter` é rápido porque o mapa está na memória, mas abrir um
  depósito grande relê tudo. Um banco real guardaria um *snapshot* e leria só
  o log depois dele.
- **Sem segmentação.** Um log de verdade é partido em arquivos por tamanho ou
  por tempo, o que permite apagar segmento antigo sem reescrever nada.
- **Sem concorrência.** Um processo por arquivo; não há trava, e dois
  escritores ao mesmo tempo intercalam registros.
- **Sem transação.** `acrescentarVarios` escreve tudo numa chamada, mas não há
  garantia de que os registros apareçam todos ou nenhum se a queda for no meio
  do `write`.
- O `fsync` garante o que o sistema operacional promete; disco que mente sobre
  cache de escrita continua mentindo.

## Licença

MIT.
