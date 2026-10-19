(() => {
  var __defProp = Object.defineProperty;
  var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

  // src/index.js
  var domain_whitelist = [
    "github.com",
    "avatars.githubusercontent.com",
    "github.githubassets.com",
    "collector.github.com",
    "api.github.com",
    "raw.githubusercontent.com",
    "gist.githubusercontent.com",
    "github.io",
    "assets-cdn.github.com",
    "cdn.jsdelivr.net",
    "securitylab.github.com",
    "www.githubstatus.com",
    "npmjs.com",
    "git-lfs.github.com",
    "githubusercontent.com",
    "github.global.ssl.fastly.net",
    "api.npms.io",
    "github.community",
    "desktop.github.com",
    "central.github.com"
  ];
  var domain_mappings = Object.fromEntries(
    domain_whitelist.map((domain) => [domain, domain.replace(/\./g, "-") + "-"])
  );
  var redirect_paths = [];
  var enable_geo_redirect = true;
  addEventListener("fetch", (event) => {
    event.respondWith(handleRequest(event.request));
  });
  async function handleRequest(request) {
        const url = new URL(request.url);
    const full_url_match = url.pathname.match(/^\/https?:?\/+github\.com(\/.*)$/i);
    if (full_url_match) {
      url.pathname = full_url_match[1];
    }
    const current_host = url.host.toLowerCase();
    const host_header = request.headers.get("Host");
    const effective_host = (host_header || current_host).toLowerCase();
    if (enable_geo_redirect) {
      const country = request.headers.get("CF-IPCountry") || "";
      if (country && country !== "CN") {
        const host_prefix2 = getProxyPrefix(effective_host);
        if (host_prefix2) {
          const target_host2 = resolveTargetHost(host_prefix2);
          if (target_host2) {
            const original_url = new URL(url.href);
            original_url.host = target_host2;
            original_url.protocol = "https:";
            return Response.redirect(original_url.href, 302);
          }
        }
      }
    }
    if (redirect_paths.includes(url.pathname)) {
      return new Response("Not Found", { status: 404 });
    }
    if (url.protocol === "http:") {
      url.protocol = "https:";
      return Response.redirect(url.href);
    }
    const host_prefix = getProxyPrefix(effective_host);
    if (!host_prefix) {
      return new Response(`Domain not configured for proxy. Host: ${effective_host}, Prefix check failed`, { status: 404 });
    }
    const target_host = resolveTargetHost(host_prefix);
    if (!target_host) {
      return new Response(`Domain not configured for proxy. Host: ${effective_host}, Prefix: ${host_prefix}, Target lookup failed`, { status: 404 });
    }
    let pathname = url.pathname;
    pathname = pathname.replace(/(\/[^\/]+\/[^\/]+\/(?:latest-commit|tree-commit-info)\/[^\/]+)\/https%3A\/\/[^\/]+\/.*/, "$1");
    pathname = pathname.replace(/(\/[^\/]+\/[^\/]+\/(?:latest-commit|tree-commit-info)\/[^\/]+)\/https:\/\/[^\/]+\/.*/, "$1");
    const new_url = new URL(url);
    new_url.host = target_host;
    new_url.pathname = pathname;
    new_url.protocol = "https:";
    const new_headers = new Headers(request.headers);
    new_headers.set("Host", target_host);
    new_headers.set("Referer", new_url.href);
    new_headers.delete("accept-encoding");
    try {
      const response = await fetch(new_url.href, {
        method: request.method,
        headers: new_headers,
        body: request.method !== "GET" ? request.body : void 0,
        redirect: "manual"
        // 处理重定向，避免自动跟随导致的问题
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (location) {
          const modified_location = modifyUrl(location, host_prefix, effective_host);
          const new_res_headers = new Headers(response.headers);
          new_res_headers.set("location", modified_location);
          return new Response(null, {
            status: response.status,
            headers: new_res_headers
          });
        }
      }
      const new_response_headers = new Headers(response.headers);
      new_response_headers.set("x-gh-proxy", "patched-v2");
      new_response_headers.set("access-control-allow-origin", "*");
      new_response_headers.set("access-control-allow-credentials", "true");
      new_response_headers.set("cache-control", "public, max-age=14400");
      new_response_headers.delete("content-security-policy");
      new_response_headers.delete("content-security-policy-report-only");
      new_response_headers.delete("clear-site-data");
      const content_type = response.headers.get("content-type") || "";
      const is_text = content_type.includes("text/") || content_type.includes("application/json") || content_type.includes("application/javascript") || content_type.includes("application/xml");
      if (response.status === 200 && is_text) {
        new_response_headers.delete("content-encoding");
        new_response_headers.delete("content-length");
        let text = await response.text();
        text = await modifyText(text, host_prefix, effective_host);
        return new Response(text, {
          status: response.status,
          headers: new_response_headers
        });
      }
      return new Response(response.body, {
        status: response.status,
        headers: new_response_headers
      });
    } catch (err) {
      return new Response(`Proxy Error: ${err.message}`, { status: 502 });
    }
  }
  __name(handleRequest, "handleRequest");
  function getProxyPrefix(host) {
    if (host.startsWith("gh.")) {
      return "gh.";
    }
    const ghMatch = host.match(/^([a-z0-9-]+-gh\.)/);
    if (ghMatch) {
      return ghMatch[1];
    }
    return null;
  }
  __name(getProxyPrefix, "getProxyPrefix");
  function resolveTargetHost(host_prefix) {
    if (host_prefix === "gh.") {
      return "github.com";
    }
    if (host_prefix && host_prefix.endsWith("-gh.")) {
      const prefix_part = host_prefix.slice(0, -4);
      for (const original of Object.keys(domain_mappings)) {
        const normalized_original = original.trim().toLowerCase();
        if (normalized_original.replace(/\./g, "-") === prefix_part) {
          return original;
        }
      }
    }
    return null;
  }
  __name(resolveTargetHost, "resolveTargetHost");
  async function modifyText(text, host_prefix, effective_hostname) {
    const domain_suffix = effective_hostname.substring(host_prefix.length);
    for (const [original_domain, _] of Object.entries(domain_mappings)) {
      const escaped_domain = original_domain.replace(/\./g, "\\.");
      const full_proxy_domain = original_domain === "github.com" ? `gh.${domain_suffix}` : `${original_domain.replace(/\./g, "-")}-gh.${domain_suffix}`;
      text = text.replace(
        new RegExp(`https?://${escaped_domain}(?=/|"|'|\\s|$)`, "g"),
        `https://${full_proxy_domain}`
      );
      text = text.replace(
        new RegExp(`//${escaped_domain}(?=/|"|'|\\s|$)`, "g"),
        `//${full_proxy_domain}`
      );
    }
    return text;
  }
  __name(modifyText, "modifyText");
  function modifyUrl(url_str, host_prefix, effective_hostname) {
    try {
      const url = new URL(url_str);
      const domain_suffix = effective_hostname.substring(host_prefix.length);
      for (const [original_domain, _] of Object.entries(domain_mappings)) {
        if (url.host === original_domain) {
          url.host = original_domain === "github.com" ? `gh.${domain_suffix}` : `${original_domain.replace(/\./g, "-")}-gh.${domain_suffix}`;
          break;
        }
      }
      return url.href;
    } catch (e) {
      return url_str;
    }
  }
  __name(modifyUrl, "modifyUrl");
})();
//# sourceMappingURL=index.js.map
