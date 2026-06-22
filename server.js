require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { criarPagamentoPix, criarPagamentoCartao } = require('./getnet');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const CART_TOKEN_TTL = '30d'; // validade do carrinho sem login

if (!process.env.JWT_SECRET) {
  console.warn('⚠️ JWT_SECRET não definido no .env; usando segredo padrão de desenvolvimento.');
}

app.use(helmet({ crossOriginResourcePolicy: false, contentSecurityPolicy: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ══════════════════════════════════════
// CARRINHO SEM LOGIN — token anônimo com expiração
// Lê o cookie "cart_token"; se não existir ou estiver
// expirado/inválido, cria um novo carrinho anônimo.
// ══════════════════════════════════════
function lerCookie(req, nome) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  const partes = raw.split(';').map(p => p.trim());
  for (const p of partes) {
    const idx = p.indexOf('=');
    if (idx > -1 && p.slice(0, idx) === nome) return decodeURIComponent(p.slice(idx + 1));
  }
  return null;
}

function setCartCookie(res, cartId) {
  const novoToken = jwt.sign({ cartId }, SECRET, { expiresIn: CART_TOKEN_TTL });
  res.setHeader('Set-Cookie',
    `cart_token=${encodeURIComponent(novoToken)}; Max-Age=${30 * 24 * 60 * 60}; Path=/; HttpOnly; SameSite=Lax`);
}

function carrinhoAnonimo(req, res, next) {
  const token = lerCookie(req, 'cart_token');
  let cartId = null;

  if (token) {
    try {
      const payload = jwt.verify(token, SECRET);
      cartId = payload.cartId;
    } catch (err) {
      cartId = null; // expirado/inválido: gera um novo abaixo
    }
  }

  if (!cartId) {
    cartId = crypto.randomUUID();
  }

  // Renova a validade a cada visita (sliding expiration):
  // quem usa o carrinho continuamente nunca perde os 30 dias;
  // só expira de fato após 30 dias SEM nenhuma visita.
  setCartCookie(res, cartId);

  req.cartId = cartId;
  next();
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/api', (req, res) => {
  res.json({ status: 'ok', mensagem: 'API Tintas Super Casa rodando ✅' });
});

// ══════════════════════════════════════
// PRODUTOS — preços sempre do banco
// ══════════════════════════════════════
app.get('/api/produtos', async (req, res) => {
  const { category } = req.query;
  let query = supabase
    .from('produtos')
    .select('id, name, category, price, old_price, description, badge, img')
    .eq('ativo', true)
    .order('id');
  if (category && category !== 'all') query = query.eq('category', category);
  const { data, error } = await query;
  if (error) {
    console.error('Erro ao buscar produtos:', error);
    return res.status(500).json({ erro: 'Erro ao buscar produtos.' });
  }
  res.json(data || []);
});

// ══════════════════════════════════════
// CARRINHO — sem login, identificado pelo cookie cart_token
// ══════════════════════════════════════
app.get('/api/carrinho', carrinhoAnonimo, async (req, res) => {
  const { data } = await supabase.from('carrinho').select('*').eq('usuario_id', req.cartId);
  res.json(data || []);
});

app.post('/api/carrinho', carrinhoAnonimo, async (req, res) => {
  const { produto_id, nome, quantidade, img } = req.body;
  if (!produto_id || !nome)
    return res.status(400).json({ erro: 'Dados incompletos.' });

  // Busca o preço sempre do banco — nunca aceita preço do cliente
  const { data: produto } = await supabase
    .from('produtos').select('price').eq('id', produto_id).single();
  if (!produto)
    return res.status(404).json({ erro: 'Produto não encontrado.' });

  const preco = parseFloat(produto.price);
  const qtd = parseInt(quantidade) || 1;

  const { data: existente } = await supabase
    .from('carrinho').select('*')
    .eq('usuario_id', req.cartId)
    .eq('produto_id', String(produto_id)).single();

  if (existente) {
    await supabase.from('carrinho')
      .update({ quantidade: existente.quantidade + qtd })
      .eq('id', existente.id);
  } else {
    await supabase.from('carrinho')
      .insert([{ usuario_id: req.cartId, produto_id: String(produto_id), nome, preco, quantidade: qtd, img: img || '' }]);
  }

  const { data: carrinho } = await supabase.from('carrinho').select('*').eq('usuario_id', req.cartId);
  res.json({ mensagem: 'Item adicionado!', carrinho: carrinho || [] });
});

app.put('/api/carrinho/:id', carrinhoAnonimo, async (req, res) => {
  const qtd = parseInt(req.body.quantidade);
  if (!qtd || qtd < 1) return res.status(400).json({ erro: 'Quantidade inválida.' });

  const { data: item } = await supabase.from('carrinho').select('*')
    .eq('id', req.params.id).eq('usuario_id', req.cartId).single();
  if (!item) return res.status(404).json({ erro: 'Item não encontrado.' });

  await supabase.from('carrinho').update({ quantidade: qtd }).eq('id', req.params.id);
  const { data: carrinho } = await supabase.from('carrinho').select('*').eq('usuario_id', req.cartId);
  res.json({ mensagem: 'Atualizado!', carrinho: carrinho || [] });
});

app.delete('/api/carrinho/:id', carrinhoAnonimo, async (req, res) => {
  await supabase.from('carrinho').delete().eq('id', req.params.id).eq('usuario_id', req.cartId);
  const { data: carrinho } = await supabase.from('carrinho').select('*').eq('usuario_id', req.cartId);
  res.json({ mensagem: 'Removido!', carrinho: carrinho || [] });
});

app.delete('/api/carrinho', carrinhoAnonimo, async (req, res) => {
  await supabase.from('carrinho').delete().eq('usuario_id', req.cartId);
  res.json({ mensagem: 'Carrinho limpo!', carrinho: [] });
});

// ══════════════════════════════════════
// PEDIDOS — total calculado no servidor, sem login
// ══════════════════════════════════════
app.post('/api/pedidos', carrinhoAnonimo, async (req, res) => {
  const { data: itens } = await supabase.from('carrinho').select('*').eq('usuario_id', req.cartId);
  if (!itens || !itens.length) return res.status(400).json({ erro: 'Carrinho vazio.' });

  // Dados de contato/entrega informados no checkout (sem cadastro de usuário)
  const { nome, telefone, endereco, forma_pagamento } = req.body || {};

  // Busca preços do banco — nunca usa o preço salvo no carrinho
  const ids = itens.map(i => i.produto_id);
  const { data: produtosDb } = await supabase.from('produtos').select('id, price').in('id', ids);

  const total = itens.reduce((s, i) => {
    const prod = produtosDb?.find(p => String(p.id) === String(i.produto_id));
    return s + (prod?.price || 0) * i.quantidade;
  }, 0);

  const { data: pedido, error } = await supabase
    .from('pedidos')
    .insert([{
      usuario_id: req.cartId,
      nome_cliente: nome || null,
      telefone: telefone || null,
      endereco: endereco || null,
      forma_pagamento: forma_pagamento || null,
      status: 'pendente',
      total
    }])
    .select().single();
  if (error) return res.status(500).json({ erro: 'Erro ao criar pedido.' });

  const itensPedido = itens.map(i => {
    const prod = produtosDb?.find(p => String(p.id) === String(i.produto_id));
    return {
      pedido_id: pedido.id,
      produto_id: i.produto_id,
      nome: i.nome,
      preco: prod?.price || 0,
      quantidade: i.quantidade
    };
  });

  await supabase.from('pedido_itens').insert(itensPedido);
  await supabase.from('carrinho').delete().eq('usuario_id', req.cartId);

  res.status(201).json({ mensagem: 'Pedido realizado!', pedido_id: pedido.id, total });
});

app.get('/api/pedidos', carrinhoAnonimo, async (req, res) => {
  const { data: pedidos } = await supabase
    .from('pedidos').select('*')
    .eq('usuario_id', req.cartId)
    .order('criado_em', { ascending: false });

  if (!pedidos) return res.json([]);

  const pedidosComItens = await Promise.all(pedidos.map(async (p) => {
    const { data: itens } = await supabase.from('pedido_itens').select('*').eq('pedido_id', p.id);
    return { ...p, itens: itens || [] };
  }));

  res.json(pedidosComItens);
});

// ══════════════════════════════════════
// PAGAMENTOS — GetNet (Pix + Cartão)
// ══════════════════════════════════════
app.post('/api/pagamentos/pix/:pedidoId', carrinhoAnonimo, async (req, res) => {
  const { data: pedido } = await supabase
    .from('pedidos').select('*')
    .eq('id', req.params.pedidoId).eq('usuario_id', req.cartId).single();
  if (!pedido) return res.status(404).json({ erro: 'Pedido não encontrado.' });

  try {
    const pix = await criarPagamentoPix({
      pedidoId: pedido.id,
      valor: pedido.total,
      descricao: `Tintas Super Casa - Pedido ${pedido.id}`
    });

    await supabase.from('pedidos')
      .update({ forma_pagamento: 'pix', pagamento_id: pix.payment_id })
      .eq('id', pedido.id);

    res.json(pix);
  } catch (err) {
    console.error('Erro Pix GetNet:', err);
    res.status(500).json({ erro: 'Não foi possível gerar o Pix agora. Tente novamente.' });
  }
});

app.post('/api/pagamentos/cartao/:pedidoId', carrinhoAnonimo, async (req, res) => {
  const { cardToken, parcelas } = req.body || {};
  if (!cardToken) return res.status(400).json({ erro: 'Token do cartão não informado.' });

  const { data: pedido } = await supabase
    .from('pedidos').select('*')
    .eq('id', req.params.pedidoId).eq('usuario_id', req.cartId).single();
  if (!pedido) return res.status(404).json({ erro: 'Pedido não encontrado.' });

  try {
    const resultado = await criarPagamentoCartao({
      pedidoId: pedido.id,
      valor: pedido.total,
      cardToken,
      parcelas: parcelas || 1,
      cliente: pedido.nome_cliente ? { name: pedido.nome_cliente } : undefined
    });

    const novoStatus = resultado.status === 'APPROVED' ? 'pago' : 'pendente';
    await supabase.from('pedidos')
      .update({ forma_pagamento: 'cartao', pagamento_id: resultado.payment_id, status: novoStatus })
      .eq('id', pedido.id);

    res.json(resultado);
  } catch (err) {
    console.error('Erro Cartão GetNet:', err);
    res.status(500).json({ erro: 'Não foi possível processar o cartão agora.' });
  }
});

// Webhook — a GetNet chama esta rota pra confirmar pagamentos (Pix e cartão).
// NUNCA confiamos no navegador do cliente pra marcar "pago"; só nesta notificação.
app.post('/api/webhook/getnet', express.json(), async (req, res) => {
  try {
    const { payment_id, status } = req.body || {};
    if (!payment_id) return res.sendStatus(400);

    if (status === 'APPROVED' || status === 'CONFIRMED') {
      await supabase.from('pedidos').update({ status: 'pago' }).eq('pagamento_id', payment_id);
    } else if (status === 'DENIED' || status === 'CANCELLED') {
      await supabase.from('pedidos').update({ status: 'cancelado' }).eq('pagamento_id', payment_id);
    }

    res.sendStatus(200); // GetNet exige 200 pra não reenviar a notificação
  } catch (err) {
    console.error('Erro webhook GetNet:', err);
    res.sendStatus(500);
  }
});

// Na Vercel (ambiente serverless) o app é exportado e a própria Vercel
// cuida de "ligar" as requisições — não rodamos app.listen() lá.
// Localmente (node server.js) continuamos rodando normal com listen().
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`\n✅ API rodando em http://localhost:${PORT}`);
    console.log(`🔒 Segurança: helmet + rate limit + bcrypt + JWT\n`);
  });
}

module.exports = app;