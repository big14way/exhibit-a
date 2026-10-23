FROM node:20-bookworm-slim

WORKDIR /app

# Install only the root toolchain. Workspace packages are TypeScript source
# resolved by tsx through tsconfig paths, so the image does not need a
# workspace-aware package manager or a second lockfile.
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
RUN npm ci --no-audit --no-fund

COPY apps ./apps
COPY packages ./packages
COPY analytics ./analytics
COPY fixtures ./fixtures
COPY scripts ./scripts
COPY evals ./evals

ENV SAMPLE_MODE=true
ENV EXHIBIT_A_QUIET=1

CMD ["npm", "run", "cli", "--", "investigate", "is the FY2018 jump real?", "--metric", "analytics.sector_revenue_by_year"]
