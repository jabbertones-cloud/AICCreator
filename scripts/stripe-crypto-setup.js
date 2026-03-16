#!/usr/bin/env node
"use strict";

/**
 * stripe-crypto-setup.js
 * 
 * Checks and helps configure Stripe crypto wallet support
 * Verifies crypto payment method is enabled and guides through onboarding
 */

require("dotenv").config({ override: true });

// Import getStripe function
let _stripe = null;
function getStripe() {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY not set");
    const Stripe = require("stripe");
    _stripe = new Stripe(key, { apiVersion: "2024-06-20" });
  }
  return _stripe;
}

async function checkCryptoSupport() {
  const stripe = getStripe();
  
  console.log("=".repeat(60));
  console.log("Stripe Crypto Wallet Support Check");
  console.log("=".repeat(60));

  try {
    // Check account capabilities
    const account = await stripe.accounts.retrieve();
    console.log("\n📋 Account Status:");
    console.log(`   Type: ${account.type}`);
    console.log(`   Country: ${account.country}`);
    console.log(`   Charges Enabled: ${account.charges_enabled ? "✅" : "❌"}`);
    console.log(`   Payouts Enabled: ${account.payouts_enabled ? "✅" : "❌"}`);

    // Check payment method configuration
    console.log("\n💳 Payment Methods:");
    
    // Try to create a test checkout session to see what methods are available
    try {
      const testSession = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: [{
          price_data: {
            currency: "usd",
            product_data: { name: "Test" },
            unit_amount: 100,
          },
          quantity: 1,
        }],
        payment_method_types: ["card", "crypto"],
        success_url: process.env.STRIPE_SUCCESS_URL || "https://localhost/callback/success",
        cancel_url: process.env.STRIPE_CANCEL_URL || "https://localhost/callback/cancel",
      });
      
      console.log("   ✅ Crypto payment method type is supported");
      console.log(`   Test session created: ${testSession.id}`);
      
      // Clean up test session
      await stripe.checkout.sessions.expire(testSession.id);
    } catch (err) {
      if (err.code === "payment_method_type_not_supported" || err.message.includes("crypto")) {
        console.log("   ❌ Crypto payment method not enabled");
        console.log("\n   To enable crypto:");
        console.log("   1. Go to Stripe Dashboard → Settings → Payment methods");
        console.log("   2. Find 'Crypto' in the list");
        console.log("   3. Click 'Enable' or 'Activate'");
        console.log("   4. Complete any required onboarding steps");
      } else {
        console.log(`   ⚠️  Could not verify crypto support: ${err.message}`);
      }
    }

    // Check if account has crypto capabilities
    const capabilities = account.capabilities || {};
    console.log("\n🔧 Account Capabilities:");
    for (const [cap, status] of Object.entries(capabilities)) {
      if (cap.includes("crypto") || cap.includes("payments")) {
        console.log(`   ${cap}: ${status === "active" ? "✅" : status === "pending" ? "⏳" : "❌"} ${status}`);
      }
    }

    console.log("\n" + "=".repeat(60));
    console.log("Next Steps:");
    console.log("=".repeat(60));
    console.log("\n1. Enable Crypto in Stripe Dashboard:");
    console.log("   https://dashboard.stripe.com/settings/payment_methods");
    console.log("\n2. If crypto onboarding form is required:");
    console.log("   - Complete business verification");
    console.log("   - Provide wallet addresses");
    console.log("   - Complete compliance checks");
    console.log("\n3. Test crypto payment:");
    console.log("   - Create a test checkout session");
    console.log("   - Verify crypto option appears");
    console.log("   - Complete test payment");
    console.log("\n4. Add to .env (optional):");
    console.log("   STRIPE_ENABLE_CRYPTO=true");
    console.log("\n" + "=".repeat(60));

  } catch (err) {
    console.error("\n❌ Error checking Stripe crypto support:", err.message);
    if (err.type === "StripeAuthenticationError") {
      console.error("\n   Check your STRIPE_SECRET_KEY in .env");
    }
    process.exit(1);
  }
}

async function enableCryptoOnboarding() {
  const stripe = getStripe();
  
  console.log("\n🔐 Crypto Onboarding Guide");
  console.log("=".repeat(60));
  
  try {
    const account = await stripe.accounts.retrieve();
    
    console.log("\nTo enable crypto payments, you need to:");
    console.log("\n1. Complete Business Verification (if not done):");
    console.log("   - Stripe Dashboard → Settings → Business");
    console.log("   - Provide business details");
    console.log("   - Upload verification documents");
    
    console.log("\n2. Enable Crypto Payment Method:");
    console.log("   - Stripe Dashboard → Settings → Payment methods");
    console.log("   - Find 'Crypto' → Click 'Enable'");
    console.log("   - Complete any required forms");
    
    console.log("\n3. Configure Wallet Addresses (if required):");
    console.log("   - Stripe will guide you through wallet setup");
    console.log("   - Provide addresses for receiving crypto payments");
    
    console.log("\n4. Test in Test Mode First:");
    console.log("   - Use Stripe test mode");
    console.log("   - Test with test crypto wallets");
    console.log("   - Verify webhook handling");
    
    console.log("\n📚 Documentation:");
    console.log("   https://stripe.com/docs/payments/crypto");
    console.log("   https://dashboard.stripe.com/settings/payment_methods");
    
  } catch (err) {
    console.error("Error:", err.message);
  }
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args[0] === "onboarding") {
    await enableCryptoOnboarding();
  } else {
    await checkCryptoSupport();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal error:", err.message);
    process.exit(1);
  });
}

module.exports = { checkCryptoSupport, enableCryptoOnboarding };
