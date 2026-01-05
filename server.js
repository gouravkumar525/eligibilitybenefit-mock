import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";

const app = express();
app.use(cors());

// Availity token endpoint uses x-www-form-urlencoded
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/**
 * In-memory store (good for demos).
 * For production-like behavior, use Redis/Postgres.
 */
const coverages = new Map();

/**
 * Minimal "client registry" using env vars
 * Set these on Render:
 *   CLIENT_ID, CLIENT_SECRET
 */
const CLIENT_ID = process.env.CLIENT_ID || "demo_client";
const CLIENT_SECRET = process.env.CLIENT_SECRET || "demo_secret";

// Very lightweight token issuance (for demo)
function issueToken() {
  // Not a real JWT; good enough for mocking client behavior.
  return `mock_${uuidv4().replaceAll("-", "")}`;
}

function requireBearer(req, res, next) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return res.status(401).json({ error: "missing_bearer_token" });
  const token = auth.slice("Bearer ".length).trim();
  if (!token.startsWith("mock_")) return res.status(401).json({ error: "invalid_token" });
  next();
}

/**
 * 1) Token endpoint: POST /v1/token
 * Body: grant_type=client_credentials&client_id=...&client_secret=...&scope=...
 */
app.post("/v1/token", (req, res) => {
  const { grant_type, client_id, client_secret } = req.body;

  if (grant_type !== "client_credentials") {
    return res.status(400).json({ error: "unsupported_grant_type" });
  }
  if (client_id !== CLIENT_ID || client_secret !== CLIENT_SECRET) {
    return res.status(401).json({ error: "invalid_client" });
  }

  const access_token = issueToken();

  res.json({
    token_type: "Bearer",
    access_token,
    expires_in: 900, // 15 min
    scope: req.body.scope || "healthcare-hipaa-transactions"
  });
});

/**
 * 2) Create coverage inquiry: POST /availity/v1/coverages
 * Content-Type: application/x-www-form-urlencoded
 * Example inputs:
 * payerId=00590&providerNpi=...&asOfDate=...&serviceType[]=30&memberId=...
 */
app.post("/availity/v1/coverages", requireBearer, (req, res) => {
  // normalize serviceType[] form inputs
  let serviceTypes = req.body["serviceType[]"] ?? req.body.serviceType ?? [];
  if (!Array.isArray(serviceTypes)) serviceTypes = [serviceTypes];

  const id = `cvg_${uuidv4()}`;
  const createdAt = Date.now();

  // Keep request snapshot
  const record = {
    id,
    status: "PENDING",
    createdAt,
    request: {
      payerId: req.body.payerId,
      providerNpi: req.body.providerNpi,
      asOfDate: req.body.asOfDate,
      memberId: req.body.memberId,
      patientBirthDate: req.body.patientBirthDate,
      patientLastName: req.body.patientLastName,
      patientFirstName: req.body.patientFirstName,
      patientGender: req.body.patientGender,
      patientState: req.body.patientState,
      subscriberRelationship: req.body.subscriberRelationship,
      requestedPatientSearchOption: req.body.requestedPatientSearchOption,
      serviceTypes
    }
  };

  coverages.set(id, record);

  // Mimic async processing: mark completed after 1.5s
  setTimeout(() => {
    const r = coverages.get(id);
    if (!r) return;

    r.status = "COMPLETED";

    // Build a response that “looks like” eligibility/benefits JSON
    const benefits = [];

    // Always include plan coverage (30) if requested
    if (serviceTypes.includes("30")) {
      benefits.push({
        serviceType: "30",
        serviceTypeDescription: "Health Benefit Plan Coverage",
        coverageStatus: "ACTIVE",
        effectiveDate: "2025-01-01",
        terminationDate: null
      });
    }

    // If 98 requested, include “Professional Visit” benefit and an auth flag example
    if (serviceTypes.includes("98")) {
      benefits.push({
        serviceType: "98",
        serviceTypeDescription: "Professional (Physician) Visit",
        inNetwork: true,
        authorizationRequired: true,
        coPay: { amount: 30.0, currency: "USD" },
        coInsurance: { percentage: 20 },
        deductible: { total: 1500.0, remaining: 800.0 },
        outOfPocket: { total: 5000.0, remaining: 3200.0 }
      });
    }

    // If nothing specific requested, provide something broad
    if (benefits.length === 0) {
      benefits.push({
        serviceType: "30",
        serviceTypeDescription: "Health Benefit Plan Coverage",
        coverageStatus: "ACTIVE",
        effectiveDate: "2025-01-01",
        terminationDate: null
      });
    }

    r.response = {
      id,
      status: "COMPLETED",
      payer: { id: r.request.payerId || "UNKNOWN", name: "Mock Payer" },
      subscriber: {
        memberId: r.request.memberId,
        firstName: r.request.patientFirstName,
        lastName: r.request.patientLastName,
        dateOfBirth: r.request.patientBirthDate
      },
      benefits,
      messages: [{ code: "INFO", text: "Eligibility returned in real-time (mock)" }],
      source: { transactionType: "X12_270_271", responseTimeMs: 850 }
    };

    coverages.set(id, r);
  }, 1500);

  res.status(202).json({
    id,
    status: "PENDING",
    links: {
      self: `/availity/v1/coverages/${id}`
    }
  });
});

/**
 * 3) Fetch coverage result: GET /availity/v1/coverages/:id
 */
app.get("/availity/v1/coverages/:id", requireBearer, (req, res) => {
  const record = coverages.get(req.params.id);
  if (!record) return res.status(404).json({ error: "not_found" });

  if (record.status !== "COMPLETED") {
    return res.json({ id: record.id, status: record.status });
  }
  return res.json(record.response);
});

app.get("/", (_req, res) => res.send("Availity-like mock is running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Mock listening on ${PORT}`));
