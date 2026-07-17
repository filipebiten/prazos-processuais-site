# Prazos Processuais — Dashboard

Frontend estático (sem build, sem dependências) para o
[sistema de controle de prazos processuais](https://github.com/filipebiten/prazos-processuais).

Este repositório é **público de propósito**: contém apenas HTML/JS estático, sem
nenhum dado de processo ou cliente. Os dados reais ficam em um repositório privado
separado e são lidos em tempo real, no navegador, via API do GitHub — nunca
armazenados aqui.

## Por quê um repositório separado?

GitHub Pages em repositório privado só publica com controle de acesso em contas
GitHub Pro/Team/Enterprise. Para manter tudo gratuito, o frontend fica num repo
público (sem dados sensíveis) e busca os JSONs do repo privado autenticado com um
token fornecido pelo próprio usuário, direto do navegador.

## Uso

1. Acesse a página publicada (GitHub Pages).
2. Clique em "⚙ Configurar acesso" e informe:
   - Dono do repositório e nome do repositório privado de dados
     (`filipebiten/prazos-processuais`).
   - Um *fine-grained personal access token* do GitHub, criado em
     Settings → Developer settings → Personal access tokens → Fine-grained tokens,
     restrito a esse repositório, com permissões `Contents: Read` e
     `Actions: Read and write`.
3. O token fica salvo só no `localStorage` do seu navegador — nunca é enviado a
   nenhum servidor além da API do GitHub (`api.github.com`).

## Como funciona

- Leitura: `GET /repos/{owner}/{repo}/contents/data/prazos.json` (e `publicacoes.json`)
  com `Accept: application/vnd.github.raw+json`.
- Ação "Marcar cumprido": dispara `POST /repos/{owner}/{repo}/actions/workflows/marcar-cumprido.yml/dispatches`
  — o workflow no repositório privado atualiza o status e comita. Como o site é
  estático, é preciso clicar em "Atualizar" alguns segundos depois para ver o
  resultado.

## Publicar no GitHub Pages

Settings → Pages → Source: `Deploy from a branch` → branch `main`, pasta `/ (root)`.
