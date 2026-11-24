# Calculadora de tributos pelas notas fiscais

Calcula quanto de imposto a empresa paga a partir das notas fiscais que emitiu, nos dois regimes:

- **Simples Nacional**: o DAS do mês pelas regras da LC 123 e, com a Reforma Tributária, a CBS e o IBS de cada
  nota pela calculadora oficial do Simples.
- **Regime regular** (Lucro Presumido ou Lucro Real): a CBS, o IBS (estadual e municipal) e o Imposto Seletivo de
  cada item, pela calculadora oficial do regime regular.

As contas da Reforma são portes fiéis, para JavaScript, das calculadoras publicadas pela Receita Federal
([calculadora-rtc-regime-regular](https://github.com/ReceitaFederal/calculadora-rtc-regime-regular) 1.7.2 e
[calculadora-rtc-simples-nacional](https://github.com/ReceitaFederal/calculadora-rtc-simples-nacional) 1.0.2),
sobre a mesma base de dados oficial. Elas foram comparadas resposta a resposta com o código Java da Receita
(veja [Validação](#validação)).

Tudo roda na sua máquina. Nenhuma nota é enviada para a internet.

---

## Rodar em 4 passos

1. Instale o **Node.js 22.13 ou mais novo** ([nodejs.org](https://nodejs.org), versão LTS) e confira com
   `node --version`. Antes da 22.13 o Node não tem o módulo `node:sqlite`: o servidor avisa e não abre.
2. Baixe o projeto e entre na pasta dele:

   ```bash
   git clone https://github.com/Afonsodalvi/calculadora-tributos.git
   cd calculadora-tributos
   ```

   (ou baixe o ZIP pelo botão *Code* do GitHub e abra a pasta descompactada no terminal).
3. Instale as dependências (uma vez só):

   ```bash
   npm install
   ```

4. Inicie:

   ```bash
   npm start
   ```

Abra **http://localhost:5180**. Para parar, `Ctrl+C` no terminal.

Para conferir a instalação, rode os testes (nenhum pode falhar):

```bash
npm test
```

Ao final aparecem `fail 0` e 15 testes pulados (`skipped`): 10 casos que a própria Receita deixou desativados nos
testes dela, 4 comparações ao vivo com o Java, que só rodam quando você pede (veja [Validação](#validação)), e 1
teste com DANFSe reais, que ficam fora do repositório.

---

## Como usar

No topo da página escolha o regime da empresa. A escolha fica salva no navegador.

### Simples Nacional

1. **Notas**: arraste os PDFs (DANFSe) ou XMLs (NFS-e nacional, NF-e, NFC-e), ou clique em *Prefiro digitar os
   valores* e informe mês, valor e o que foi vendido. A calculadora sugere a atividade do Simples pelo código do
   serviço (LC 116) ou pelo CFOP; confira e troque se precisar. Notas substituídas, de entrada, de devolução, de
   outro CNPJ (filiais da mesma empresa contam juntas) ou enviadas duas vezes ficam fora do cálculo, com o motivo na
   tela; uma nota de outro CNPJ pode ser incluída com *Incluir mesmo assim*. Notas canceladas ficam fora quando o
   PDF do DANFSe traz a marca CANCELADA, quando o XML da NF-e/NFC-e foi exportado já cancelado, ou quando você
   arrasta, junto com as notas, o XML do evento de cancelamento (NF-e/NFC-e 110111/110112 registrado pela SEFAZ;
   NFS-e e101101, e105102, e105104 ou e305101). O XML da NFS-e nacional não diz que a nota foi cancelada: para ela,
   envie o evento.
2. **Dados da empresa**: informe o faturamento dos 12 meses anteriores (RBT12) de cada mês (está no extrato do
   PGDAS-D). Se houver serviço sujeito ao Fator "r", informe também a folha de salários do mesmo período.
3. **Resultado**: o DAS estimado de cada mês, a divisão entre os tributos (IRPJ, CSLL, Cofins, PIS, CPP, ICMS, ISS),
   a conta passo a passo e, marcando a opção, como fica com as regras de 2027 (CBS e IBS dentro do DAS) e a CBS/IBS
   que vai destacada em cada nota.

### Lucro Presumido ou Lucro Real (regime regular)

1. **Notas**: arraste os XMLs (ou PDFs de DANFSe). Do XML da NF-e/NFC-e lemos, item a item, NCM, quantidade,
   valores (produto, frete, seguro, descontos, ICMS, PIS, Cofins…), o grupo IBSCBS (CST, cClassTrib e tributação
   regular) e o Imposto Seletivo; da NFS-e lemos NBS, classificação, local de incidência e valores. Também dá para
   digitar uma operação (*Prefiro digitar uma operação*): data, documento, NCM ou NBS, classificação tributária,
   município e base de cálculo. As mesmas regras do Simples tiram do cálculo notas repetidas, substituídas,
   canceladas ou de outro CNPJ.
2. **Confira antes de calcular**: para cada nota aparecem a data do fato gerador, o município onde o IBS é devido
   (e de onde ele foi tirado) e a classificação tributária de cada item, todos editáveis. Quando a nota não traz
   classificação, usamos 000001 (tributação integral) e avisamos. Para operações de 2027 em diante a calculadora
   oficial exige as alíquotas nominais (CBS, IBS estadual, IBS municipal): elas aparecem para preencher, e cada
   item com Imposto Seletivo pede a alíquota do IS (já vem preenchida quando a nota a destaca).
3. **Resultado**: o total de CBS, IBS e IS por mês, nota por nota, com:
   - a conferência com os valores já destacados na nota (quando o XML traz o grupo IBSCBS);
   - o detalhamento de cada item (base, alíquota, redução, memória de cálculo oficial);
   - para NF-e e NFC-e, o botão **Gerar o XML do grupo IBS/CBS**, pronto para o documento fiscal;
   - a requisição e a resposta exatas da calculadora oficial.

   Se alguma nota ou item não pôde ser calculado, o mês avisa "Total incompleto" e diz quantos ficaram de fora.

Em 2026 a CBS (0,9%) e o IBS (0,1%) estão em fase de teste: são destacados na nota e compensados com PIS/Cofins.

### Consultar tabelas oficiais

Busca de classificações tributárias (cClassTrib) vigentes numa data, alíquotas de referência da União, do estado e do
município, e a descrição de NCM e NBS, direto das tabelas oficiais.

---

## API

Tudo o que a tela faz está disponível por HTTP. A documentação navegável fica em **http://localhost:5180/api.html** e
o documento OpenAPI 3.1 em `http://localhost:5180/api/openapi.json` (importe no Postman, Insomnia ou Swagger
Editor).

Há dois grupos de rotas:

| Grupo | Rotas | Para que serve |
|---|---|---|
| Contrato oficial | `/api/calculadora/...` (52 operações do regime regular e 5 do Simples), `/api/versao` e `/api/versao/status` | As mesmas requisições e respostas das APIs Java da Receita. Quem já integra com a calculadora oficial só troca a URL base. |
| Aplicação | `/api/notas`, `/api/simples/*`, `/api/regime-regular/*`, `/api/info`, `/api/saude`, `/api/openapi.json` (também em `/api/api-docs`) | Leitura de notas fiscais e o fluxo da tela (notas → cálculo). |

Exemplo, cálculo de uma operação no regime regular:

```bash
curl -s -X POST http://localhost:5180/api/calculadora/observabilidade/regime-geral \
  -H 'Content-Type: application/json' \
  -d '{"id":"1","versao":"1.0.0","dhFatoGerador":"2026-03-10T10:00:00-03:00","municipio":4314902,"uf":"RS",
       "itens":[{"numero":1,"ncm":"10063021","cst":"000","cClassTrib":"000001","baseCalculo":100.00}]}'
```

Ler uma nota e calcular pelo fluxo da aplicação (regime regular: nota → operações → cálculo oficial). Rode na pasta
onde está o `nota.xml` (XML de NF-e, NFC-e ou NFS-e, ou o PDF do DANFSe):

```bash
curl -s -X POST http://localhost:5180/api/notas -H 'x-filename: nota.xml' --data-binary @nota.xml > nota.json
node -e "process.stdout.write(JSON.stringify({ notas: [require('./nota.json').nota] }))" \
  | curl -s -X POST http://localhost:5180/api/regime-regular/preparar -H 'Content-Type: application/json' --data-binary @- > operacoes.json
curl -s -X POST http://localhost:5180/api/regime-regular/calcular -H 'Content-Type: application/json' --data-binary @operacoes.json
```

`/api/regime-regular/preparar` recebe o campo `nota` de cada resposta de `/api/notas` (não a resposta inteira) e
devolve as operações com data, município do IBS e itens; dá para conferir e editar `operacoes.json` antes de calcular.
Para operações de 2027 em diante acrescente ao `operacoes.json` as alíquotas nominais, em %:
`"aliquotas": {"cbs": "8.8", "ibsEstadual": "0.05", "ibsMunicipal": "0.05"}` (itens com Imposto Seletivo usam
`item.aliquotasIS`, que vem da nota, ou `aliquotas.impostoSeletivo`). Uma nota com data anterior a 2026 volta como não
calculada (`notasNaoCalculadas`): a calculadora oficial só aceita fatos geradores a partir de 2026.

Pela API, quem decide o que entra no cálculo é você: a tela tira notas repetidas, substituídas, canceladas e de outro
CNPJ antes de calcular; `/api/regime-regular/*` calcula todas as notas e operações que receber. Cada requisição
aceita até 500 notas ou operações, 5.000 itens (990 por nota) e 2 MB; para mais, envie em lotes e some os resumos
(a tela faz isso sozinha).

A mesma nota no Simples Nacional (DAS do mês; informe o RBT12 do mês e, se houver Fator "r", a folha de 12 meses):

```bash
node -e "const n = require('./nota.json').nota; process.stdout.write(JSON.stringify({ notas: [n], empresa: { [n.competencia]: { rbt12: '240000.00', folha12: '' } } }))" \
  | curl -s -X POST http://localhost:5180/api/simples/calcular -H 'Content-Type: application/json' --data-binary @-
```

Com o servidor publicado com token, acrescente `-H "Authorization: Bearer $(cat ~/calculadora-api-token.txt)"` a
cada `curl` (o arquivo do token é criado no passo a passo abaixo).

### Publicar a API para outras pessoas

Por padrão o servidor escuta só em `127.0.0.1` (só esta máquina). Para colocar num servidor, configure por variáveis
de ambiente:

| Variável | Padrão | Uso |
|---|---|---|
| `HOST` | `127.0.0.1` | Endereço em que o servidor escuta. Atrás de um proxy reverso na mesma máquina, deixe `127.0.0.1`; `0.0.0.0` aceita conexões de qualquer interface da rede. |
| `PORT` | `5180` | Porta. |
| `API_TOKEN` | — | Token aleatório (16+ caracteres) exigido em todas as rotas `/api/*`, exceto `/api/saude`, `/api/info`, `/api/openapi.json` e `/api/api-docs`. Envie `Authorization: Bearer <token>` ou `X-API-Key: <token>`. A tela pede o token quando precisa. O servidor não abre com o token de exemplo desta documentação nem com um token de menos de 5 caracteres diferentes. |
| `PUBLIC_API` | — | `1` para publicar **sem** token (de propósito). Sem `API_TOKEN` nem `PUBLIC_API=1`, o servidor se recusa a abrir na rede. |
| `ALLOWED_HOSTS` | — | Nomes públicos do servidor (ex.: `calc.suaempresa.com.br`). Outros cabeçalhos Host são recusados. |
| `CORS_ORIGINS` | — | Sites que podem chamar a API pelo navegador (ex.: `https://app.suaempresa.com.br`; `*` libera todos). |
| `RATE_LIMIT` | `120` com `HOST` de rede, `0` (desligado) com `HOST=127.0.0.1` | Requisições por minuto por IP. IPv6 conta por bloco /64 e também por /48 (8 vezes o limite), já que um cliente costuma ter um bloco inteiro. Atrás de proxy, com `HOST=127.0.0.1`, defina `RATE_LIMIT=120`. A tabela guarda até 50.000 endereços por minuto; numa inundação acima disso, os novos passam a ser contados por faixa (IPv4 /16, IPv6 /32, 16 vezes o limite) e depois todos juntos (64 vezes o limite): ninguém fica sem limite e um ataque não bloqueia todos os clientes novos. |
| `TRUST_PROXY` | — | `1` só quando **toda** requisição chega pelo seu proxy reverso: o IP do cliente (usado no limite por IP) passa a ser a última entrada do `X-Forwarded-For`, a que o proxy acrescenta (só se for um IP válido; senão vale o IP da conexão). Confia num proxy só: com proxies em cadeia ou CDN, o último deve gravar o IP real do cliente. Sem proxy, deixe desligado. |
| `TRUSTED_PROXIES` | rede local e privada | Com `TRUST_PROXY=1`: IPs ou faixas CIDR do proxy (ex.: `10.0.0.5,::1`). O `X-Forwarded-For` só é lido de conexões vindas daí; o padrão aceita `127.0.0.0/8`, `::1`, link-local (`169.254/16`, `fe80::/10`) e as faixas privadas (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`), o que inclui a ponte do Docker. Com `HOST=0.0.0.0` numa rede local, informe o IP exato do proxy. Sem `TRUST_PROXY=1` ou com uma entrada inválida, o servidor não abre. |
| `RTC_API_URL` | — | Opcional: faz as rotas `/api/regime-regular/*` usarem outra instância da API oficial (por exemplo, a Java da Receita) em vez do porte embutido. |

O servidor fala HTTP simples: para a internet, ponha na frente um proxy reverso com HTTPS (Caddy, Nginx) e deixe a
calculadora escutando só em `127.0.0.1`, para que ninguém chegue nela sem passar pelo proxy (o token iria sem
criptografia e o `X-Forwarded-For` poderia ser forjado). Passo a passo num servidor Linux com Node e o proxy na mesma
máquina:

```bash
git clone https://github.com/Afonsodalvi/calculadora-tributos.git calculadora-tributos && cd calculadora-tributos
npm ci --omit=dev
```

Gere o token uma vez, guarde-o num arquivo que só o seu usuário lê e entregue o valor mostrado a quem vai usar a API:

```bash
(umask 077 && openssl rand -hex 24 > ~/calculadora-api-token.txt)
echo "Token da API: $(cat ~/calculadora-api-token.txt)"
```

Inicie (a cada vez, com o mesmo token):

```bash
HOST=127.0.0.1 PORT=5180 API_TOKEN="$(cat ~/calculadora-api-token.txt)" ALLOWED_HOSTS=calc.suaempresa.com.br TRUST_PROXY=1 RATE_LIMIT=120 npm start
```

Proxy com Caddy (`Caddyfile`), que emite o certificado sozinho e repassa o nome do site e o IP do cliente:

```
calc.suaempresa.com.br {
  reverse_proxy 127.0.0.1:5180
}
```

Com Nginx, repasse o nome do site (sem isso a tela recebe 403 de origem) e o IP do cliente:

```
location / {
  proxy_pass http://127.0.0.1:5180;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

Se o proxy fica em outra máquina, use `HOST=0.0.0.0`, libere a porta 5180 no firewall só para o IP do proxy e informe
esse IP em `TRUSTED_PROXIES`. Sem proxy nenhum (só numa rede interna confiável), use `HOST=0.0.0.0` sem `TRUST_PROXY`:
o token trafega sem criptografia.

Com Docker (proxy no mesmo host; `127.0.0.1:` no `-p` publica a porta só para esta máquina, já que o Docker abre
portas publicadas passando por cima do firewall do host):

```bash
docker build -t calculadora-tributos .
```

```bash
docker run -d --name calculadora -p 127.0.0.1:5180:5180 -e API_TOKEN="$(cat ~/calculadora-api-token.txt)" -e ALLOWED_HOSTS=calc.suaempresa.com.br -e TRUST_PROXY=1 calculadora-tributos
```

Dentro do contêiner o servidor escuta em `0.0.0.0` (o limite de 120 req/min por IP já vem ligado). O contêiner tem
verificação de saúde (`GET /api/saude`, na porta de `PORT`) e roda como usuário sem privilégios.

Proteções que já vêm ligadas:

- o token é comparado em tempo constante;
- o corpo das requisições tem limite: 16 MB em `/api/calculadora/regime-geral`,
  `/api/calculadora/observabilidade/regime-geral` e `/api/calculadora/xml/*`; 2 MB nas demais rotas, inclusive
  `/api/notas`, com um arquivo por requisição e o XML de uma nota limitado a 1 MB;
- o trabalho por requisição tem limite: 10.000 itens por operação nas rotas de cálculo oficiais; 500 notas ou
  operações, 5.000 itens e 990 por nota em `/api/regime-regular/*`; 2.000 notas e 10.000 itens em
  `/api/simples/calcular`;
- PDFs são lidos um por vez numa thread separada (worker), com até 32 MB descompactados, 10 s e 128 MB de heap por
  arquivo; cabem 8 PDFs ao mesmo tempo (contando o que está sendo lido), no máximo 2 de cada cliente. Acima disso a
  resposta é 429 com `Retry-After`, que a tela respeita sozinha;
- caminhos malformados respondem 400/404 sem registrar a requisição no log; erros internos viram uma linha de log
  curta, sem pilha;
- a página tem Content-Security-Policy sem scripts de terceiros; o banco é aberto só para leitura;
  nenhuma nota é gravada em disco.

---

## Como está organizado

```
calculadora-tributos/
├── server.js                 entrada: lê a configuração e sobe o servidor HTTP
├── src/
│   ├── app.js                monta os módulos, a segurança HTTP e os arquivos da tela
│   ├── http/                 configuração, segurança (host, origem, token, CORS, limite) e roteador
│   ├── core/                 decimal exato (BigInt, como o BigDecimal do Java) e acesso ao banco oficial
│   ├── notas/                leitura de DANFSe (PDF), XML de NFS-e e de NF-e/NFC-e
│   ├── simples/              módulo Simples Nacional: DAS (LC 123) + porte da calculadora oficial (rtc/)
│   └── regime-regular/       módulo Regime Regular: porte da calculadora oficial, por fatia
│       ├── calculo/          cálculo de CBS/IBS/IS (motor/ e orquestração), erros
│       ├── base-calculo/     bases de cálculo, NFS-e e pedágio
│       ├── dados-abertos/    tabelas oficiais (classificações, alíquotas, NCM, NBS…)
│       ├── xml/              geração e validação do XML dos grupos IBS/CBS (XSD oficiais)
│       ├── versao/           versão da base e da aplicação
│       ├── comum/            JSON, erros (ProblemDetail), arredondamento — iguais ao Java
│       └── aplicacao.js      rotas da tela: notas → operações → cálculo
├── data/                     base oficial (calculadora-pro.db) e tabelas da LC 123 (anexos.json)
├── public/                   a tela (HTML, CSS e JavaScript sem framework) e /api.html
├── docs/                     OpenAPI (deste servidor e os oficiais exportados das APIs Java)
├── scripts/                  geração da base e do OpenAPI
└── test/                     testes, vetores oficiais e comparação com o Java
```

Cada módulo registra as próprias rotas (`registrar(roteador)` em `src/*/modulo.js` e `rotas.js` de cada fatia).
Para acrescentar um regime ou ferramenta, crie a pasta em `src/`, exporte um módulo com `registrar` e inclua-o na
lista de `src/app.js`.

### Base de dados oficial

`data/calculadora-pro.db` é gerado das migrações Flyway publicadas pela Receita (versão V0073, 09/11/2026). Quando
a Receita publicar migrações novas:

```bash
npm run build-db -- /caminho/para/calculadora-rtc-regime-regular/flyway/sql
```

e rode `npm test`. A base nova é montada em `data/calculadora-pro.db.novo` e só substitui a atual depois que todas as
migrações rodaram: se a pasta estiver errada ou uma migração falhar, a base atual fica como estava.

---

## Validação

`npm test` roda 2.926 testes: num clone novo, 2.911 passam, 0 falham e 15 são pulados (veja
[Rodar em 4 passos](#rodar-em-4-passos)); na máquina do autor, com os DANFSe reais, são 14 pulados.
Eles incluem:

- **Vetores oficiais**: 2.261 casos extraídos dos testes das duas calculadoras da Receita (1.689 do regime regular e
  572 do Simples; entradas e saídas esperadas), executados pelo servidor HTTP real.
- **Comparação com o Java oficial** (feita durante o desenvolvimento; para repetir, veja abaixo): as APIs Java da
  Receita foram compiladas e executadas localmente (JDK 25, perfil offline, sem acesso à rede). A suíte oficial passou
  (regime regular: 1.314 testes, 0 falhas, 10 ignorados pela própria suíte; Simples: 376 testes, 0 falhas) e as
  mesmas requisições foram enviadas ao Java e a esta calculadora. Na versão final, 86.905 casos comparados byte a
  byte (status, corpo e cabeçalhos relevantes), com **0 divergências**: 77.420 no regime regular (cálculo, bases de
  cálculo, dados abertos, XML e erros, com respostas 200, 4xx e 500 idênticas) e 9.485 no Simples. Rodadas anteriores,
  com outras sementes, também terminaram em 0. A comparação só ignora o que muda a cada execução do próprio Java:
  data/hora, o host nas URLs, a ordem de listas que o Java não ordena (`HashSet`) e a mensagem de
  `NullPointerException` que a JVM omite depois de aquecida. Os scripts ficam em `test/regime-regular/diferencial/`
  e `test/simples/diferencial/`.
- **Revisão adversarial**: uma revisão independente procurou erros de cálculo, de leitura de notas e de segurança. Os
  40 problemas confirmados foram corrigidos, cada um com um teste que falha sem a correção (`test/**/revisao-*.test.js`
  e `test/regime-regular/aplicacao-revisao.test.js`); mais duas revisões, das próprias correções, acharam outros 10,
  também corrigidos e testados.
- **DAS do Simples**: a tabela 2018–2026 confere célula a célula com uma transcrição independente da LC 123 (244
  células, `test/simples/das.test.js`); em todos os períodos, inclusive os da LC 214, a partilha soma 100% e a soma
  dos percentuais bate com a alíquota efetiva; há casos conferidos à mão (teto do ISS, diferença centesimal,
  Fator "r", exclusões). O ISS calculado também foi conferido com o ISS impresso em NFS-e reais, num teste que só
  roda na máquina do autor (as notas e os valores ficam fora do repositório).
- **Leitura de notas**: XMLs oficiais de exemplo (NF-e, NFC-e, NFS-e com e sem IBS/CBS), em `test/notas/` e
  `test/simples/notas-e-calculo.test.js`. O teste com DANFSe (PDF) reais só roda na máquina do autor:
  `test/fixtures/private` fica fora do git e, sem essa pasta, o teste é pulado.
- **Servidor**: token, CORS, limite por IP, cabeçalhos de segurança, limites de tamanho e de trabalho, e bloqueio de
  acesso a arquivos fora da pasta pública (`test/http/`).

Para repetir a comparação com o Java, compile as duas APIs oficiais (veja o README de cada repositório da Receita) e
suba-as como esta calculadora responde por padrão: perfil offline, sem consultar a versão na internet (a URL de
versão aponta para uma porta fechada) e com idioma e fuso do Brasil. Na pasta de cada repositório:

```bash
# regime regular, porta 8080
OTEL_SDK_DISABLED=true VERSAO_OFFLINE_URL=http://127.0.0.1:9/ java -Duser.language=pt -Duser.country=BR -Duser.timezone=America/Sao_Paulo -Dspring.profiles.active=offline -jar target/api-regime-geral.jar --server.address=127.0.0.1 --management.server.address=127.0.0.1
```

```bash
# Simples Nacional, porta 8082
OTEL_SDK_DISABLED=true VERSAO_URL=http://127.0.0.1:9/ java -Duser.language=pt -Duser.country=BR -Duser.timezone=America/Sao_Paulo -Dspring.profiles.active=offline -jar target/api-simples-nacional.jar --server.address=127.0.0.1 --management.server.address=127.0.0.1
```

Depois, na pasta deste projeto:

```bash
ORACULO_URL=http://127.0.0.1:8080 node --disable-warning=ExperimentalWarning test/regime-regular/diferencial/rodar.mjs
```

```bash
JAVA_URL=http://127.0.0.1:8082/api node --disable-warning=ExperimentalWarning test/simples/diferencial/comparar-com-java.mjs
```

O `npm test` também tem uma comparação ao vivo com o Java do regime regular, mas ela só roda quando você pede:
`ORACULO_URL=http://127.0.0.1:8080 npm test`. Sem `ORACULO_URL` esses testes aparecem como pulados, para que o
resultado não dependa do que estiver escutando na porta 8080.

---

## Limites conhecidos

**Simples Nacional**

- Empresas com RBT12 acima de R$ 3,6 milhões: tributos federais pela 6ª faixa e ICMS/ISS/IBS pela fórmula da 5ª
  faixa enquanto o sublimite não é excedido no ano (a pergunta aparece na tela). O excedente do ISS acima do teto é
  redistribuído pelos coeficientes da 5ª faixa (Anexos III e IV) e, no Anexo V até 2026, pela tabela da Res. CGSN
  140; no Anexo V a partir de 2027 o ISS é só limitado ao teto.
- Uma atividade por nota (NF-e com CFOPs de tipos diferentes mostra aviso).
- Início de atividade: informe o RBT12 já proporcionalizado (média mensal × 12; nos 2 primeiros meses de 2027 em
  diante, 1ª faixa).
- PIS/Cofins monofásico (medicamentos, autopeças, bebidas, combustíveis) não é excluído automaticamente; o ICMS-ST é
  detectado pelo CFOP (x404/x405).
- Exportadoras: o RBT12 informado vale para receita interna e de exportação (a lei manda considerá-las separadamente
  na alíquota).
- MEI não é calculado (valores fixos mensais).
- De 2029 a 2032 o teto do ISS segue as notas dos Anexos III e IV da LC 214 (4,5%, 4%, 3,5% e 3%), que divergem do
  texto do art. 18 §1-B, I (5%).
- Atividade com IPI e ISS simultâneos (art. 18 §4º, VI) não é modelada.

**Regime regular**

- Em 2026 valem as alíquotas de teste (CBS 0,9%, IBS 0,1%). De 2027 em diante a tabela oficial ainda não traz as
  alíquotas: você as informa e o resultado vem marcado como simulado, como na calculadora da Receita.
- A calculadora oficial só aceita fatos geradores a partir de 2026; notas anteriores aparecem como não calculadas.
- O município do IBS de uma NFS-e sem o grupo IBS/CBS é deduzido (local de incidência, tomador, prestação, prestador)
  e aparece para conferir; a classificação padrão, quando a nota não traz, é 000001 (tributação integral).

**Notas fiscais**

- Imagens de nota (JPG/PNG) não são lidas.
- PDF de DANFSe cifrado (mesmo só com senha de proprietário) ou com compactação LZW, RunLength ou Brotli é recusado:
  envie o XML.
- O XML da NFS-e nacional não informa cancelamento: envie o XML do evento junto (veja [Como usar](#como-usar)).

**Diferenças em relação às APIs Java** (só em entradas fora do uso normal)

- As rotas de cálculo oficiais aceitam até 10.000 itens por operação (o Java aceita qualquer quantidade); acima disso
  respondem 413.
- Em `/api/calculadora/xml/validate`, um texto acima de 64 KB num campo com tamanho máximo é recusado por tamanho
  (`cvc-maxLength-valid`), e não pelo padrão (`cvc-pattern-valid`) como no Java. Até 64 KB a mensagem é a mesma.
- Um número com expoente gigantesco (escala acima de 100.000, como `1e300000000`) em
  `aliquotasNominais.impostoSeletivo.adRem` ou nos valores de `gComponentesBC` responde 500 com mensagem própria, sem
  travar o servidor. Nos demais campos (base de cálculo, alíquotas de CBS e IBS) a resposta é a mesma do Java.
- No Simples, uma data com ano de 5 dígitos (`+12027-05-10`) responde 422 (VSN-012); o Java responde 500.
- A interface do Swagger do Java (`/swagger-ui`) não existe aqui: o mesmo documento está em `/api/openapi.json` e
  `/api/api-docs`, e a página navegável em `/api.html`. As respostas não são compactadas (gzip).

**Servidor**

- Um processo só, sem banco de dados próprio: o limite por IP vale por processo. Com várias instâncias, limite no
  proxy.
- As rotas de cálculo oficiais calculam uma operação inteira de uma vez: uma operação de 10.000 itens ocupa o servidor
  por cerca de 2,5 s. Para uso público, limite também no proxy o tamanho e a frequência das requisições.

Valores estimados para conferência; a apuração oficial é feita no PGDAS-D e nos sistemas da Receita.
