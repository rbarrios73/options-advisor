// Spanish for the text that is not a literal in a component: labels kept in tables (some of them in
// the shared domain code), messages the server sends back, and sentences the domain code builds
// with numbers in them. The literals themselves are in i18n.es.js.
//
// The domain code stays English and pure — it is shared with the server and its tests — so its
// sentences are translated here by shape: a pattern for each sentence, with the numbers carried
// across. A sentence with no pattern shows in English and is listed in window.__i18nMissing.

// "Dec 18" (how the domain code writes a date) → "18 dic".
const MONTHS = { Jan: 'ene', Feb: 'feb', Mar: 'mar', Apr: 'abr', May: 'may', Jun: 'jun', Jul: 'jul', Aug: 'ago', Sep: 'sep', Oct: 'oct', Nov: 'nov', Dec: 'dic' };
const when = (text) => text.replace(/^([A-Z][a-z]{2}) (\d{1,2})$/, (m, mon, day) => (MONTHS[mon] ? `${day} ${MONTHS[mon]}` : m));

// Put is masculine and call is feminine in the Spanish traders use: "el put corto", "la call corta".
const the = (type) => (type === 'call' ? 'la call' : 'el put');
const ofThe = (type) => (type === 'call' ? 'de la call' : 'del put');
const short = (type) => (type === 'call' ? 'la call corta' : 'el put corto');
const side = (word) => (word === 'above' ? 'por encima' : 'por debajo');
const days = (n) => (Number(n) === 1 ? '1 día' : `${n} días`);

export const esExtra = {
  // --- pages ---
  Screener: 'Escáner',
  Watchlist: 'Lista',
  Positions: 'Posiciones',
  Dividends: 'Dividendos',
  Ticker: 'Ticker',
  Simulator: 'Simulador',
  Users: 'Usuarios',
  Audit: 'Auditoría',
  Account: 'Cuenta',
  Language: 'Idioma',

  // --- positions ---
  'Show trading results': 'Mostrar resultados de trading',
  'Hide trading results': 'Ocultar resultados de trading',
  'Premium, cost to close and ROI for any date range.': 'Prima, costo de cierre y ROI para cualquier rango de fechas.',

  // --- the same English word, two Spanish ones ---
  'By##date': 'Para el',
  'Open##action': 'Abrir',
  'Open##price': 'Apertura',
  'Close##price': 'Cierre',
  'Closed##mix': 'Cierres',
  'Opened##event': 'Apertura',
  'Rolled##event': 'Roll',
  'Closed##event': 'Cierre',

  // --- strategies and position types ---
  'Put credit spread': 'Spread de crédito con puts',
  'Call credit spread': 'Spread de crédito con calls',
  'Long call': 'Call larga',
  'Long put': 'Put largo',
  'Vertical put credit spread': 'Spread vertical de crédito con puts',
  'Vertical call credit spread': 'Spread vertical de crédito con calls',
  'Cash secured put': 'Put asegurado con efectivo',
  'Covered call': 'Call cubierta',
  Wheel: 'Rueda',
  "Poor man's covered call": 'Poor man’s covered call',
  'Iron condor': 'Cóndor de hierro',
  'Short put delta': 'Delta del put corto',
  'Short call delta': 'Delta de la call corta',
  'Bid/ask': 'Bid/ask',
  Mid: 'Medio',
  Ask: 'Ask',
  'Sell a put, buy a cheaper one below it for protection. Bullish and defined-risk: you keep the credit if the price stays above the break-even, and the width caps what you can lose.':
    'Vende un put y compra uno más barato por debajo como protección. Alcista y de riesgo definido: conservas el crédito si el precio se mantiene por encima del punto de equilibrio, y el ancho limita lo que puedes perder.',
  'Sell a call, buy a dearer one above it for protection. Bearish and defined-risk: the mirror of the put spread, so you keep the credit if the price stays BELOW the break-even, and the width caps what you can lose.':
    'Vende una call y compra una por encima como protección. Bajista y de riesgo definido: el espejo del spread de puts, así que conservas el crédito si el precio se mantiene POR DEBAJO del punto de equilibrio, y el ancho limita lo que puedes perder.',
  'Buy a call. Bullish, and the most you can lose is what you paid — but time decay works against you every day, and the price has to clear the break-even before any of it is profit.':
    'Compra una call. Alcista, y lo máximo que puedes perder es lo que pagaste — pero el paso del tiempo juega en tu contra cada día, y el precio tiene que superar el punto de equilibrio antes de que haya ganancia.',
  'Buy a put. Bearish, and the most you can lose is what you paid. The same time decay applies: the price has to fall past the break-even before any of it is profit.':
    'Compra un put. Bajista, y lo máximo que puedes perder es lo que pagaste. Aplica el mismo decaimiento: el precio tiene que caer más allá del punto de equilibrio antes de que haya ganancia.',

  // --- legs and the price-by-date table ---
  sell: 'venta',
  buy: 'compra',
  now: 'ahora',
  short: 'corta',
  long: 'larga',
  'break-even': 'equilibrio',

  // --- statuses, periods, severities, themes ---
  Open: 'Abierta',
  Rolled: 'Rolada',
  Closed: 'Cerrada',
  Assigned: 'Asignada',
  'This week': 'Esta semana',
  'Last week': 'Semana pasada',
  'This month': 'Este mes',
  'Last month': 'Mes pasado',
  'Year to date': 'En el año',
  Opened: 'Apertura',
  'Act now': 'Actúa ya',
  Watch: 'Vigilar',
  Note: 'Nota',
  Light: 'Claro',
  Dark: 'Oscuro',
  System: 'Sistema',

  // --- screener filters, columns and score parts ---
  'Min days to expiry': 'Días mín. al vencimiento',
  'Max days to expiry': 'Días máx. al vencimiento',
  'Min strike width': 'Ancho mín. entre strikes',
  'Max strike width': 'Ancho máx. entre strikes',
  'Max short-leg delta': 'Delta máx. de la pata corta',
  'Min win probability': 'Prob. mín. de ganar',
  'Min return on risk': 'Retorno mín. sobre riesgo',
  'Min liquidity score': 'Liquidez mínima',
  'Max loss per contract ($)': 'Pérdida máx. por contrato ($)',
  'Expiries per symbol': 'Vencimientos por símbolo',
  'Preferred days to expiry': 'Días al vencimiento preferidos',
  Score: 'Calif.',
  DTE: 'Días',
  Strikes: 'Strikes',
  'Max loss': 'Pérdida máx.',
  Return: 'Retorno',
  'Win prob': 'Prob. ganar',
  EV: 'VE',
  Liq: 'Liq.',
  Liquidity: 'Liquidez',
  'Time to expiry': 'Tiempo al vencimiento',
  'Which of these has the best balance of win probability and return on risk?':
    '¿Cuál de estos tiene el mejor equilibrio entre probabilidad de ganar y retorno sobre riesgo?',
  'What would you be wary of in the top five?': '¿De qué desconfiarías en los cinco primeros?',
  'Which ones suit holding for about a month, and why?': '¿Cuáles convienen para mantener cerca de un mes, y por qué?',
  'Where are two candidates close enough that the ranking is not meaningful?':
    '¿Dónde hay dos candidatos tan parecidos que el orden no significa nada?',

  // --- forecast ---
  'Options are priced for bigger moves than the stock has been making. That gap is the cushion a premium seller is paid for — and it is often there because the market expects news.':
    'Las opciones descuentan movimientos más grandes de los que la acción ha tenido. Esa diferencia es el colchón por el que se le paga al vendedor de prima — y suele estar ahí porque el mercado espera noticias.',
  'Options are priced about in line with how much the stock has actually been moving.':
    'Las opciones están valoradas más o menos en línea con lo que la acción se ha movido en realidad.',
  'Options are priced for smaller moves than the stock has been making. Selling premium pays less for the risk here; buying it costs less than usual.':
    'Las opciones descuentan movimientos más pequeños de los que la acción ha tenido. Vender prima paga menos por el riesgo aquí; comprarla cuesta menos de lo habitual.',

  // --- dividends ---
  Monthly: 'Mensual',
  Quarterly: 'Trimestral',
  'Twice a year': 'Dos veces al año',
  'Once a year': 'Una vez al año',
  'No read on this': 'Sin lectura',
  'Nothing flagged': 'Nada que señalar',
  'Worth watching': 'Vale la pena vigilar',
  Stretched: 'Forzado',
  'Too little history here to say anything either way.': 'Muy poco historial aquí para decir algo en un sentido u otro.',

  // --- simulator ---
  'Most of it lands in the final stretch: these strikes are close enough to the money that there is still real time value in them, and it falls away quickly at the end.':
    'La mayor parte llega en el tramo final: estos strikes están tan cerca del dinero que todavía tienen valor temporal real, y se pierde rápido al final.',
  'Most of it is over early. These strikes are far enough from the price that the options are nearly worthless well before expiry — theta fades rather than accelerating, which is the opposite of the usual rule of thumb.':
    'La mayor parte ocurre pronto. Estos strikes están tan lejos del precio que las opciones casi no valen nada mucho antes del vencimiento — theta se apaga en lugar de acelerarse, lo contrario de la regla habitual.',
  'It comes off at a fairly steady rate, with no part of the period doing much more of the work than another.':
    'Se va a un ritmo bastante constante, sin que una parte del periodo haga mucho más trabajo que otra.',
  'Could not find a short strike.': 'No se encontró un strike corto.',
  'The credit is at least the width of the spread — a quote artefact, not free money.':
    'El crédito es al menos el ancho del spread — un artefacto de la cotización, no dinero gratis.',
  'These quotes do not price this option above zero — an empty or stale book.':
    'Estas cotizaciones no valoran esta opción por encima de cero — un libro vacío o desactualizado.',

  // --- risk alerts and adjustments ---
  'Past the long strike': 'Más allá del strike largo',
  'Short strike is in the money': 'El strike corto está en el dinero',
  'Short strike is close': 'El strike corto está cerca',
  'Early assignment risk': 'Riesgo de asignación anticipada',
  'Pin risk': 'Riesgo de pin',
  'Loss is twice the credit': 'La pérdida es el doble del crédito',
  'Half the credit is in': 'Ya entró la mitad del crédito',
  'Inside 21 days': 'A menos de 21 días',
  'Gamma rises from here: each move in the price swings the P&L more. Many credit sellers close or roll at this point.':
    'Gamma sube desde aquí: cada movimiento del precio mueve más la G/P. Muchos vendedores de crédito cierran o rolan en este punto.',
  'Half the premium is gone': 'Se fue la mitad de la prima',
  'Out of the money near expiry': 'Fuera del dinero cerca del vencimiento',
  'Fast time decay': 'Decaimiento rápido',
  'Expiry week': 'Semana de vencimiento',
  'Earnings before expiry': 'Resultados antes del vencimiento',
  'Wide quote': 'Cotización amplia',
  'Thin open interest': 'Poco interés abierto',
  'Probabilities hidden': 'Probabilidades ocultas',
  Pricing: 'Precios',
  'Close now': 'Cerrar ahora',
  'the at-the-money implied volatility is missing or implausible': 'la volatilidad implícita en el dinero falta o no es creíble',
  'it expires today, when the model has nothing left to say': 'vence hoy, cuando el modelo ya no tiene nada que decir',

  // --- morning brief ---
  'Strike is in the money': 'El strike está en el dinero',
  'Early assignment likely': 'Asignación anticipada probable',
  'Expiring within the week': 'Vence dentro de la semana',
  'Goes ex-dividend before expiry': 'Entra en ex-dividendo antes del vencimiento',
  'Moved more than it usually does': 'Se movió más de lo habitual',
  'Expires today.': 'Vence hoy.',

  // --- audit ---
  'Signed in': 'Inició sesión',
  'Failed sign-in': 'Inicio de sesión fallido',
  'Signed out': 'Cerró sesión',
  'Created an account': 'Creó una cuenta',
  'Changed their password': 'Cambió su contraseña',
  'Password reset by an admin': 'Contraseña restablecida por un admin',
  'Account created by an admin': 'Cuenta creada por un admin',
  'Account changed by an admin': 'Cuenta modificada por un admin',
  'Account deleted by an admin': 'Cuenta eliminada por un admin',

  // --- what the server says when it refuses ---
  'Wrong email or password.': 'Correo o contraseña incorrectos.',
  'Sign in to continue.': 'Inicia sesión para continuar.',
  'Authentication required.': 'Se requiere autenticación.',
  'Administrators only.': 'Solo administradores.',
  'This app is not taking new accounts. Ask whoever runs it to add one for you.':
    'Esta aplicación no acepta cuentas nuevas. Pídele a quien la administra que te agregue una.',
  'Current password is wrong.': 'La contraseña actual es incorrecta.',
  'You cannot demote or disable your own account.': 'No puedes degradar ni deshabilitar tu propia cuenta.',
  'You cannot delete your own account.': 'No puedes eliminar tu propia cuenta.',
  'The advisor is not configured — set ANTHROPIC_API_KEY to turn it on.':
    'El asesor no está configurado — define ANTHROPIC_API_KEY para activarlo.',
  'symbol must be 1–6 letters, like SPY or BRK.B': 'el símbolo debe tener de 1 a 6 letras, como SPY o BRK.B',
  'expiration must be a date, YYYY-MM-DD': 'el vencimiento debe ser una fecha, AAAA-MM-DD',
  'No such endpoint.': 'Esa ruta no existe.',
  'Unknown role.': 'Rol desconocido.',
  'That email address already has an account.': 'Ese correo ya tiene una cuenta.',
  'No such user.': 'Ese usuario no existe.',
  'Enter a valid email address.': 'Escribe un correo válido.',
  'Password is too long.': 'La contraseña es demasiado larga.',
  'Password cannot be only spaces.': 'La contraseña no puede ser solo espacios.',
  'No such watchlist.': 'Esa lista no existe.',
  'A watchlist needs a name.': 'Una lista necesita un nombre.',
  'This is your only watchlist — empty it instead of deleting it.': 'Es tu única lista — vacíala en lugar de eliminarla.',
  'That is not a position I can store — check the symbol, type and expiry.':
    'Esa no es una posición que pueda guardar — revisa el símbolo, el tipo y el vencimiento.',
  'No such position.': 'Esa posición no existe.',
  'That change would leave the position unusable.': 'Ese cambio dejaría la posición inservible.',
  'That is not a symbol I can track.': 'Ese no es un símbolo que pueda seguir.',
  'No such holding.': 'Esa tenencia no existe.',
  'Ask a question first.': 'Primero escribe una pregunta.',
  'There are no candidates to talk about — run a scan first.': 'No hay candidatos de los que hablar — primero haz un escaneo.',
  'The model returned nothing.': 'El modelo no devolvió nada.',
  'The model took too long to answer.': 'El modelo tardó demasiado en responder.',
  'Tradier rejected the token (401). Check TRADIER_TOKEN and TRADIER_MODE.':
    'Tradier rechazó el token (401). Revisa TRADIER_TOKEN y TRADIER_MODE.',
  'Tradier rate limit hit (429). Wait a minute, or scan fewer symbols.':
    'Se alcanzó el límite de solicitudes de Tradier (429). Espera un minuto o escanea menos símbolos.',
  'Starter watchlist': 'Lista inicial',
};

// A reason the probabilities are hidden: "the 505 put has no bid".
const hiddenReason = (reason) => {
  const fixed = esExtra[reason];
  if (fixed) return fixed;
  let m = /^the (\S+) (put|call) has no (bid|ask)$/.exec(reason);
  if (m) return `${the(m[2])} de ${m[1]} no tiene ${m[3]}`;
  m = /^the (\S+) (put|call)'s quote is (\d+)% wide$/.exec(reason);
  if (m) return `la cotización ${ofThe(m[2])} de ${m[1]} tiene ${m[3]}% de amplitud`;
  return reason;
};

// One leg of "Buy back the 505 put, sell the 500 put".
const closeLeg = (part, first) => {
  const m = /^(buy back|sell) the (\S+) (put|call)$/i.exec(part);
  if (!m) return part;
  const verb = m[1].toLowerCase() === 'sell' ? 'vender' : 'recomprar';
  return `${first ? verb[0].toUpperCase() + verb.slice(1) : verb} ${the(m[3])} de ${m[2]}`;
};

export const esPatterns = [
  // --- risk alerts ---
  [/^The price is beyond both strikes\. At expiry this is the full (\S+) loss unless it comes back\.$/,
    (m) => `El precio está más allá de ambos strikes. Al vencimiento esta es la pérdida completa de ${m[1]}, a menos que regrese.`],
  [/^The price is (\S+) (above|below) the (\S+) short (put|call)(, and past the break-even)?\.$/,
    (m) => `El precio está ${m[1]} ${side(m[2])} ${ofThe(m[4])} ${m[4] === 'call' ? 'corta' : 'corto'} de ${m[3]}${m[5] ? ', y más allá del punto de equilibrio' : ''}.`],
  [/^The (\S+) strike is (\S+) away — under half the expected move to expiry \((\S+)\)\.$/,
    (m) => `El strike de ${m[1]} está a ${m[2]} — menos de la mitad del movimiento esperado al vencimiento (${m[3]}).`],
  [/^The short (put|call) is in the money with (\S+) of time value left per contract\. Short options like this can be assigned before expiry\.$/,
    (m) => `${short(m[1])[0].toUpperCase() + short(m[1]).slice(1)} está en el dinero y le quedan ${m[2]} de valor temporal por contrato. Opciones cortas como esta pueden ser asignadas antes del vencimiento.`],
  [/^Expiring with the price (between the strikes|right at the short strike): a small move at the close decides whether the short (put|call) is assigned\.$/,
    (m) => `Vence con el precio ${m[1] === 'between the strikes' ? 'entre los strikes' : 'justo en el strike corto'}: un movimiento pequeño al cierre decide si asignan ${short(m[2])}.`],
  [/^Down (\S+) against a (\S+) credit — a common point to cut the trade\.$/,
    (m) => `Pierde ${m[1]} frente a un crédito de ${m[2]} — un punto habitual para cortar la operación.`],
  [/^Closing now keeps (\S+) \((\d+)% of the maximum\) with (\d+) days of risk left — a common point to take profits\.$/,
    (m) => `Cerrar ahora conserva ${m[1]} (${m[2]}% del máximo) con ${days(m[3])} de riesgo por delante — un punto habitual para tomar ganancias.`],
  [/^Down (\S+) of the (\S+) paid\.$/, (m) => `Pierde ${m[1]} de los ${m[2]} pagados.`],
  [/^(\d+) days left and the (\S+) (put|call) is (\S+) out of the money: time value is running out fastest now\.$/,
    (m) => `Quedan ${days(m[1])} y ${the(m[3])} de ${m[2]} está ${m[4]} fuera del dinero: el valor temporal se agota más rápido ahora.`],
  [/^Theta is costing (\S+) a day — (\S+)% of what was paid\.$/, (m) => `Theta cuesta ${m[1]} al día — ${m[2]}% de lo pagado.`],
  [/^(\d+) days? left(?:: gamma is (\S+), so delta moves fast with the price)?\.$/,
    (m) => `${Number(m[1]) === 1 ? 'Queda 1 día' : `Quedan ${m[1]} días`}${m[2] ? `: gamma es ${m[2]}, así que la delta se mueve rápido con el precio` : ''}.`],
  [/^(\S+) falls inside this trade\. Prices can gap past both strikes overnight, and implied vol usually drops right after\.$/,
    (m) => `El ${m[1]} cae dentro de esta operación. Los precios pueden saltar más allá de ambos strikes de un día para otro, y la volatilidad implícita suele caer justo después.`],
  [/^The (\S+) (put|call) is (\d+)% wide \((\S+) × (\S+)\): fills will be poor, and closing costs more than the mid suggests\.$/,
    (m) => `${the(m[2])[0].toUpperCase() + the(m[2]).slice(1)} de ${m[1]} tiene ${m[3]}% de amplitud (${m[4]} × ${m[5]}): las ejecuciones serán malas, y cerrar cuesta más de lo que sugiere el punto medio.`],
  [/^Only (\d+) contracts open at the (\S+) (put|call)\. It may be hard to exit at a fair price\.$/,
    (m) => `Solo hay ${m[1]} contratos abiertos en ${the(m[3])} de ${m[2]}. Puede ser difícil salir a un precio justo.`],
  [/^Not shown because (.+)\.$/, (m) => `No se muestran porque ${m[1].split('; ').map(hiddenReason).join('; ')}.`],

  // --- adjustments ---
  [/^(?:buy back|sell) the \S+ (?:put|call)(?:, (?:buy back|sell) the \S+ (?:put|call))*$/i,
    (m) => m[0].split(', ').map((part, i) => closeLeg(part, i === 0)).join(', ')],
  [/^Roll out to (.+)$/, (m) => `Rolar al ${when(m[1])}`],
  [/^Roll out and (down|up) to (.+)$/, (m) => `Rolar al ${when(m[2])} y hacia ${m[1] === 'down' ? 'abajo' : 'arriba'}`],
  [/^Roll for a credit to (.+)$/, (m) => `Rolar por un crédito al ${when(m[1])}`],
  [/^Close this spread, sell the same (\S+) for (.+)$/, (m) => `Cerrar este spread y vender el mismo ${m[1]} para el ${when(m[2])}`],
  [/^Close this spread, sell the (\S+) for (.+)$/, (m) => `Cerrar este spread y vender el ${m[1]} para el ${when(m[2])}`],
  [/^The furthest (put|call) you can roll to for (.+) without paying: (\S+)$/,
    (m) => `${m[1] === 'call' ? 'La call más lejana' : 'El put más lejano'} al que puedes rolar para el ${when(m[2])} sin pagar: ${m[3]}`],
  [/^Sell the (\S+) (put|call) against it$/, (m) => `Vender ${the(m[2])} de ${m[1]} contra ella`],
  [/^Turns it into a (\S+) (bull call|bear put) spread for (.+)$/, (m) => `La convierte en un ${m[2]} spread ${m[1]} para el ${when(m[3])}`],
  [/^Sell this (\S+) (put|call), buy the same strike for (.+)$/,
    (m) => `Vender ${m[2] === 'call' ? 'esta call' : 'este put'} de ${m[1]} y comprar el mismo strike para el ${when(m[3])}`],

  // --- simulator ---
  [/^This expiry has fewer than two (put|call) strikes listed\.$/, (m) => `Este vencimiento tiene menos de dos strikes de ${m[1]} listados.`],
  [/^No listed (put|call) with protection (above|below) it is near (\S+) delta — the closest is (\S+)\.$/,
    (m) => `No hay ${m[1] === 'call' ? 'una call listada' : 'un put listado'} con protección ${side(m[2])} cerca de delta ${m[3]} — lo más cercano es ${m[4]}.`],
  [/^Nothing is listed (above|below) (\S+) to buy as protection\.$/, (m) => `No hay nada listado ${side(m[1])} de ${m[2]} para comprar como protección.`],
  [/^This expiry lists no (put|call)s\.$/, (m) => `Este vencimiento no lista ${m[1]}s.`],
  [/^No listed (put|call) is near (\S+) delta — the closest is (\S+)\.$/,
    (m) => `No hay ${m[1] === 'call' ? 'una call listada' : 'un put listado'} cerca de delta ${m[2]} — lo más cercano es ${m[3]}.`],
  [/^At these prices this is not a credit: buying the protection costs as much as the short (put|call) pays\. Usually a sign of an illiquid strike or a wide quote\.$/,
    (m) => `A estos precios esto no es un crédito: comprar la protección cuesta tanto como lo que paga ${short(m[1])}. Suele ser señal de un strike poco líquido o de una cotización amplia.`],
  [/^The short strike is at or (above|below) the current price: this (put|call) starts in the money\.$/,
    (m) => `El strike corto está en el precio actual o ${side(m[1])}: ${m[2] === 'call' ? 'esta call' : 'este put'} empieza en el dinero.`],
  [/^Break-even is (\S+)× the expected move away\. The market is not pricing a move that big by expiry, which is why the option is this cheap\.$/,
    (m) => `El punto de equilibrio está a ${m[1]}× el movimiento esperado. El mercado no descuenta un movimiento tan grande antes del vencimiento, por eso la opción es tan barata.`],

  // --- dividends ---
  [/^Pays out (\S+) of earnings — more than it earns\.$/, (m) => `Reparte ${m[1]} de las utilidades — más de lo que gana.`],
  [/^Pays out (\S+) of earnings, leaving little room\.$/, (m) => `Reparte ${m[1]} de las utilidades, lo que deja poco margen.`],
  [/^Pays out (\S+) of earnings\.$/, (m) => `Reparte ${m[1]} de las utilidades.`],
  [/^A (\S+) yield usually means the market expects a cut\.$/, (m) => `Un rendimiento de ${m[1]} suele significar que el mercado espera un recorte.`],
  [/^(\S+) is high enough to be worth asking why\.$/, (m) => `${m[1]} es lo bastante alto como para preguntarse por qué.`],
  [/^Cut in (\d{4}), from (\S+) to (\S+) for the year\.$/, (m) => `Recortado en ${m[1]}, de ${m[2]} a ${m[3]} en el año.`],
  [/^Held or raised for (\d+) years? running\.$/, (m) => `Mantenido o aumentado durante ${Number(m[1]) === 1 ? '1 año seguido' : `${m[1]} años seguidos`}.`],
  [/^Goes ex-dividend (\S+), and the (\S+) payment is worth more than the (\S+) of time value left — an in-the-money short call is likely to be assigned the day before\.$/,
    (m) => `Entra en ex-dividendo el ${m[1]}, y el pago de ${m[2]} vale más que los ${m[3]} de valor temporal que quedan — es probable que una call corta en el dinero sea asignada el día anterior.`],
  [/^Goes ex-dividend (\S+), before this expires\. A short call that is in the money can be assigned the day before, to collect the dividend\.$/,
    (m) => `Entra en ex-dividendo el ${m[1]}, antes de este vencimiento. Una call corta que está en el dinero puede ser asignada el día anterior, para cobrar el dividendo.`],

  // --- morning brief ---
  [/^(\S+) is at (\S+), through the (\S+) (put|call)\.$/, (m) => `${m[1]} está en ${m[2]}, más allá ${ofThe(m[4])} de ${m[3]}.`],
  [/^Expires in (\d+) days?, on (\S+)\.$/, (m) => `Vence en ${days(m[1])}, el ${m[2]}.`],
  [/^Reports on (\S+), before this expires on (\S+)\.$/, (m) => `Reporta resultados el ${m[1]}, antes de que esto venza el ${m[2]}.`],
  [/^(Up|Down) (\S+) to (\S+), about (\S+)× its usual day of (\S+)\.$/,
    (m) => `${m[1] === 'Up' ? 'Subió' : 'Bajó'} ${m[2]} a ${m[3]}, cerca de ${m[4]}× su día habitual de ${m[5]}.`],

  // --- what the server says when it refuses ---
  [/^That is the hourly limit for visitors without an account\. Sign in for unlimited (scans|lookups)\.$/,
    (m) => `Ese es el límite por hora para visitantes sin cuenta. Inicia sesión para ${m[1] === 'scans' ? 'escaneos' : 'consultas'} sin límite.`],
  [/^That is (\d+) questions this hour, which is the limit\. Each one costs money, so the ceiling is deliberate\.$/,
    (m) => `Van ${m[1]} preguntas en esta hora, que es el límite. Cada una cuesta dinero, así que el tope es deliberado.`],
  [/^Too many (sign-in|sign-up) attempts\. Try again in (\d+) minutes\.$/,
    (m) => `Demasiados intentos de ${m[1] === 'sign-in' ? 'inicio de sesión' : 'registro'}. Vuelve a intentarlo en ${m[2]} minutos.`],
  [/^Password must be at least (\d+) characters\.$/, (m) => `La contraseña debe tener al menos ${m[1]} caracteres.`],
  [/^This is the only administrator — .+ would lock everyone out\.$/, () => 'Es el único administrador — ese cambio dejaría a todos sin acceso.'],
  [/^That is the limit of (\d+) watchlists\.$/, (m) => `Ese es el límite de ${m[1]} listas.`],
  [/^That is the limit of (\d+) holdings\.$/, (m) => `Ese es el límite de ${m[1]} tenencias.`],
  [/^You already have a watchlist called “(.+)”\.$/, (m) => `Ya tienes una lista llamada “${m[1]}”.`],
  [/^That is (\d+) refreshes today — tomorrow's brief is a new one\.$/, (m) => `Van ${m[1]} actualizaciones hoy — el resumen de mañana será uno nuevo.`],
  [/^No usable price for (\S+)$/, (m) => `No hay un precio utilizable para ${m[1]}`],
  [/^Anthropic API: (.+)$/, (m) => `API de Anthropic: ${m[1]}`],
];
