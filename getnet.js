// ══════════════════════════════════════
// Integração GetNet (Pix + Cartão)
//
// Enquanto GETNET_CLIENT_ID/SECRET não estiverem no .env,
// este módulo funciona em MODO SIMULADO: gera respostas
// falsas (mas no mesmo formato) pra você testar o fluxo
// completo do site sem precisar das credenciais ainda.
//
// Quando a GetNet liberar as credenciais de sandbox/produção,
// só preencher o .env — nada no front ou no server.js muda.
// ══════════════════════════════════════
const crypto = require('crypto');

const AMBIENTE = process.env.GETNET_ENV || 'sandbox'; // 'sandbox' | 'production'
const BASE_URL = AMBIENTE === 'production'
  ? 'https://api.getnet.com.br'
  : 'https://api-sandbox.getnet.com.br';

const CLIENT_ID = process.env.GETNET_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GETNET_CLIENT_SECRET || '';
const SELLER_ID = process.env.GETNET_SELLER_ID || '';

const SIMULADO = !CLIENT_ID || !CLIENT_SECRET || !SELLER_ID;
if (SIMULADO) {
  console.warn('⚠️  GetNet em MODO SIMULADO — defina GETNET_CLIENT_ID, GETNET_CLIENT_SECRET e GETNET_SELLER_ID no .env quando tiver as credenciais reais.');
}

let tokenCache = null; // { access_token, expira_em }

async function obterToken() {
  if (SIMULADO) return 'token-simulado';

  if (tokenCache && tokenCache.expira_em > Date.now()) {
    return tokenCache.access_token;
  }

  const resp = await fetch(`${BASE_URL}/auth/oauth/v2/token`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'scope=oob&grant_type=client_credentials'
  });

  if (!resp.ok) throw new Error('Falha ao autenticar na GetNet: ' + (await resp.text()));

  const data = await resp.json();
  tokenCache = {
    access_token: data.access_token,
    expira_em: Date.now() + (data.expires_in - 60) * 1000 // renova 1min antes de expirar
  };
  return tokenCache.access_token;
}

// ── PIX ──────────────────────────────────
// Gera uma cobrança Pix vinculada a um pedido.
// Retorna { qrcode_base64, copia_e_cola, payment_id, expira_em }
async function criarPagamentoPix({ pedidoId, valor, descricao }) {
  if (SIMULADO) {
    return {
      payment_id: 'sim_pix_' + crypto.randomUUID(),
      qrcode_base64: null, // no modo real a GetNet devolve a imagem do QR em base64
      copia_e_cola: '00020126SIMULADO-PIX-NAO-USE-PARA-PAGAMENTO-REAL5204000053039865802BR',
      expira_em: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      simulado: true
    };
  }

  const token = await obterToken();
  const resp = await fetch(`${BASE_URL}/v1/payments/qrcode/pix`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'seller_id': SELLER_ID
    },
    body: JSON.stringify({
      amount: Math.round(valor * 100), // GetNet trabalha em centavos
      currency: 'BRL',
      order_id: String(pedidoId),
      description: descricao || `Pedido ${pedidoId}`
    })
  });

  if (!resp.ok) throw new Error('Falha ao gerar Pix na GetNet: ' + (await resp.text()));
  const data = await resp.json();
  return {
    payment_id: data.payment_id,
    qrcode_base64: data.additional_data?.qrcode_base64 || null,
    copia_e_cola: data.additional_data?.qrcode_data || null,
    expira_em: data.additional_data?.expiration_date || null,
    simulado: false
  };
}

// ── CARTÃO ───────────────────────────────
// `cardToken` vem do front, gerado pelo SDK/iFrame da GetNet —
// o número do cartão NUNCA passa por este servidor.
async function criarPagamentoCartao({ pedidoId, valor, cardToken, parcelas = 1, cliente }) {
  if (SIMULADO) {
    return {
      payment_id: 'sim_cartao_' + crypto.randomUUID(),
      status: 'APPROVED',
      simulado: true
    };
  }

  const token = await obterToken();
  const resp = await fetch(`${BASE_URL}/v1/payments/credit`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'seller_id': SELLER_ID
    },
    body: JSON.stringify({
      amount: Math.round(valor * 100),
      currency: 'BRL',
      order: { order_id: String(pedidoId) },
      number_installments: parcelas,
      credit: {
        delayed: false,
        authenticated: false,
        save_card_data: false,
        transaction_type: 'FULL',
        number_installments: parcelas,
        card: { token: cardToken }
      },
      customer: cliente || undefined
    })
  });

  if (!resp.ok) throw new Error('Falha ao processar cartão na GetNet: ' + (await resp.text()));
  const data = await resp.json();
  return {
    payment_id: data.payment_id,
    status: data.status, // APPROVED, DENIED, PENDING...
    simulado: false
  };
}

module.exports = { criarPagamentoPix, criarPagamentoCartao, SIMULADO };
