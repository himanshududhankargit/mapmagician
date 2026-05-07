/**
 * Static export for GitHub Pages / any static host.
 * `next build` writes plain HTML/CSS/JS into `out/` — drop that folder onto any host.
 *
 * dpplans.com is a custom domain (apex), so basePath stays empty.
 * If we ever host this under a sub-path (e.g. github.io/<repo>), set basePath here.
 */
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  // Generates /pune-dp-plan/index.html instead of /pune-dp-plan.html — better for static hosts.
  trailingSlash: true,
  // No remote image optimization on static hosts; we serve icons from CloudFront directly.
  images: { unoptimized: true },
  // Helps catch dead internal links in development.
  reactStrictMode: true,
};

module.exports = nextConfig;
