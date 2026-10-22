FROM node:20-bookworm
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY analytics ./analytics
COPY fixtures ./fixtures
COPY scripts ./scripts
RUN corepack prepare pnpm@10.12.1 --activate && pnpm install
ENV SAMPLE_MODE=true
CMD ["pnpm", "exhibit-a", "investigate", "is the FY2018 jump real?", "--metric", "analytics.sector_revenue_by_year"]
