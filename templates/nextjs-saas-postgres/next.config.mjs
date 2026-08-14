/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Fail the build on a type error rather than shipping one. This is the
  // default, and it is written down because turning it off is the first thing
  // people reach for when a build goes red — and it is how a broken app reaches
  // real users while every check still reports green.
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: false },
};

export default nextConfig;
