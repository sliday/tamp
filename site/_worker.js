// Pages Worker: static passthrough + Markdown-for-Agents content negotiation +
// Link headers (RFC 8288) + correct Content-Type for extensionless /.well-known/* files.
// Replaces _headers, which Cloudflare Pages ignores when a _worker.js is present.

const LINK_HEADER = [
  '</sitemap.xml>; rel="sitemap"; type="application/xml"',
  '</.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"',
  '</.well-known/agent-skills/index.json>; rel="https://rel.agentskills.io/index"; type="application/json"',
  '</.well-known/oauth-authorization-server>; rel="oauth-authorization-server"; type="application/json"',
  '</.well-known/openid-configuration>; rel="openid-configuration"; type="application/json"',
  '</.well-known/oauth-protected-resource>; rel="oauth-protected-resource"; type="application/json"',
  '</.well-known/mcp/server-card.json>; rel="mcp-server-card"; type="application/json"',
  '</whitepaper-latest>; rel="describedby"; type="text/html"',
  '</whitepaper.pdf>; rel="describedby"; type="application/pdf"'
].join(', ')

const CONTENT_TYPE_OVERRIDES = {
  '/robots.txt': 'text/plain; charset=utf-8',
  '/sitemap.xml': 'application/xml; charset=utf-8',
  '/index.md': 'text/markdown; charset=utf-8',
  '/.well-known/api-catalog': 'application/linkset+json; charset=utf-8',
  '/.well-known/agent-skills/index.json': 'application/json; charset=utf-8',
  '/.well-known/oauth-authorization-server': 'application/json; charset=utf-8',
  '/.well-known/openid-configuration': 'application/json; charset=utf-8',
  '/.well-known/oauth-protected-resource': 'application/json; charset=utf-8',
  '/.well-known/mcp/server-card.json': 'application/json; charset=utf-8'
}

const BLOCKED = new Set(['/_worker.js', '/_headers', '/_redirects', '/_routes.json'])

function applyCommonHeaders(h) {
  h.set('access-control-allow-origin', '*')
  h.set('referrer-policy', 'strict-origin-when-cross-origin')
  h.set('x-content-type-options', 'nosniff')
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const path = url.pathname
    const accept = (request.headers.get('accept') || '').toLowerCase()

    if (BLOCKED.has(path)) return new Response('Not Found', { status: 404 })

    // Markdown negotiation for homepage
    if ((path === '/' || path === '/index.html') && accept.includes('text/markdown')) {
      const mdUrl = new URL(url); mdUrl.pathname = '/index.md'
      const mdRes = await env.ASSETS.fetch(new Request(mdUrl, request))
      if (mdRes.ok) {
        const body = await mdRes.text()
        const h = new Headers()
        h.set('content-type', 'text/markdown; charset=utf-8')
        h.set('x-markdown-tokens', String(Math.ceil(body.length / 4)))
        h.set('vary', 'Accept')
        h.set('cache-control', 'public, max-age=3600')
        h.set('link', LINK_HEADER)
        applyCommonHeaders(h)
        return new Response(body, { status: 200, headers: h })
      }
    }

    const res = await env.ASSETS.fetch(request)
    const h = new Headers(res.headers)

    const override = CONTENT_TYPE_OVERRIDES[path]
    if (override) h.set('content-type', override)

    if (path === '/' || path === '/index.html') {
      h.set('link', LINK_HEADER)
      h.set('vary', 'Accept')
    }

    applyCommonHeaders(h)

    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h })
  }
}
