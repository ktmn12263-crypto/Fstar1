import { database, createUser } from "./database.mjs";
import { randomUUID } from "node:crypto";

console.log("Seeding initial categories and test customer account...");

const now = new Date().toISOString();

// Check if test customer exists
const customer = database.prepare("SELECT * FROM users WHERE username = 'demo_user'").get();
if (!customer) {
  createUser({
    username: "demo_user",
    password: "Password1234!",
    role: "customer"
  });
  console.log("Created demo customer user: demo_user / Password1234!");
} else {
  console.log("Demo customer user already exists.");
}

console.log("Seed completed successfully.");
