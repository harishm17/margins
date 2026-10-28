// Railway project for Margins: the Next.js app (web), the Python AI service (ai), Postgres
// with pgvector, and a bucket for uploaded materials. `railway config plan` previews changes to
// the live project and `railway config apply` makes them; see docs/deployment/RAILWAY.md.
import { bucket, defineRailway, github, postgres, preserve, project, ref, service, volume } from "railway/iac";

export default defineRailway(() => {
  const Postgres = postgres("Postgres", { region: "us-west2" });
  Postgres.networking = { privateNetworkEndpoint: "postgres" };
  const postgresVolume = volume("postgres-volume", {
    alerts: { usage: { "100": {}, "80": {}, "95": {} } },
    allowOnlineResize: true,
    region: "us-west2",
    sizeMB: 5000,
  });
  const uploads = bucket("uploads", { region: "sjc" });

  // Both services read and write materials in the bucket.
  const s3 = {
    S3_BUCKET: ref(uploads, "BUCKET"),
    S3_ENDPOINT: ref(uploads, "ENDPOINT"),
    S3_REGION: ref(uploads, "REGION"),
    S3_ACCESS_KEY_ID: ref(uploads, "ACCESS_KEY_ID"),
    S3_SECRET_ACCESS_KEY: ref(uploads, "SECRET_ACCESS_KEY"),
  };
  // Deploy each service from GitHub on every push to main, after CI passes and only when its
  // own folder changed. Needs the Railway GitHub app installed for this repository; until
  // then deploy with `railway up` (see docs/deployment/RAILWAY.md).
  const AUTO_DEPLOY_FROM_GITHUB = true;
  const fromGithub = (rootDirectory: string) =>
    AUTO_DEPLOY_FROM_GITHUB
      ? { source: github("harishm17/margins", { branch: "main", rootDirectory, checkSuites: true }) }
      : {};
  // Watch paths are relative to the repository, so they only make sense for GitHub deploys.
  const watch = (folder: string) => (AUTO_DEPLOY_FROM_GITHUB ? { watchPatterns: [`/${folder}/**`] } : {});
  // Public site address (custom domain on the web service; www redirects here).
  const SITE_URL = "https://studymargins.com";
  // The web app reaches the AI service over the private network only.
  const aiServiceUrl = "http://${{ai.RAILWAY_PRIVATE_DOMAIN}}:8000";

  const ai = service("ai", {
    ...fromGithub("ai-service"),
    build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile", ...watch("ai-service") },
    healthcheck: "/health",
    healthcheckTimeout: 120,
    replicas: { "us-west2": 1 },
    env: {
      ENVIRONMENT: "production",
      LLM_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: preserve(),
      AI_INTERNAL_TOKEN: preserve(),
      DATABASE_URL: Postgres.env.DATABASE_URL,
      PORT: "8000",
      AI_SERVICE_URL: aiServiceUrl,
      FRONTEND_URL: SITE_URL,
      ...s3,
    },
  });

  const web = service("web", {
    ...fromGithub("frontend"),
    build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile", ...watch("frontend") },
    // Apply database migrations before the new version takes traffic.
    preDeploy: ["prisma migrate deploy"],
    healthcheck: "/login",
    healthcheckTimeout: 120,
    replicas: { "us-west2": 1 },
    env: {
      ENVIRONMENT: "production",
      NEXTAUTH_SECRET: preserve(),
      NEXTAUTH_URL: SITE_URL,
      // Google sign-in (OAuth client "Margins web" in the Google Cloud project "studybuddy").
      GOOGLE_OAUTH_CLIENT_ID: preserve(),
      GOOGLE_OAUTH_CLIENT_SECRET: preserve(),
      DATABASE_URL: Postgres.env.DATABASE_URL,
      PORT: "3000",
      AI_SERVICE_URL: aiServiceUrl,
      AI_INTERNAL_TOKEN: "${{ai.AI_INTERNAL_TOKEN}}",
      ...s3,
    },
  });

  return project("study-buddy", {
    variables: { managed: true },
    resources: [ai, web, Postgres, postgresVolume, uploads],
  });
});
