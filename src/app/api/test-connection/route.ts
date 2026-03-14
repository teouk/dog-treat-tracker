import { NextResponse } from 'next/server';
import axios from 'axios';

export async function GET() {
  try {
    console.log("--- Starting Connection Test ---");

    // 1. Get Access Token
    const authResponse = await axios.post('https://api.amazon.com/auth/o2/token', {
      grant_type: 'refresh_token',
      refresh_token: process.env.SP_API_REFRESH_TOKEN,
      client_id: process.env.SP_API_CLIENT_ID,
      client_secret: process.env.SP_API_CLIENT_SECRET,
    });

    const accessToken = authResponse.data.access_token;
    console.log("✅ Step 1: Successfully received Access Token from Amazon.");

    // 2. Try to fetch one single inventory item from the UK
    // Endpoint for UK/EU is sellingpartnerapi-eu.amazon.com
    const UK_MARKETPLACE_ID = 'A1F83G8C2ARO7P';
    
    const inventoryResponse = await axios.get(
      `https://sellingpartnerapi-eu.amazon.com/fba/inventory/v1/summaries`,
      {
        headers: {
          'x-amz-access-token': accessToken,
          'Content-Type': 'application/json',
        },
        params: {
          granularityType: 'Marketplace',
          granularityId: UK_MARKETPLACE_ID,
          marketplaceIds: UK_MARKETPLACE_ID,
          details: true
        },
      }
    );

    const itemsFound = inventoryResponse.data.payload.inventorySummaries.length;
    console.log(`✅ Step 2: Connection successful! Found ${itemsFound} items.`);

    return NextResponse.json({
      status: "Success",
      message: "Your PC is successfully connected to Amazon UK!",
      itemsFound: itemsFound,
    });

  } catch (error: any) {
    console.error("❌ Test Failed:", error.response?.data || error.message);
    return NextResponse.json({
      status: "Error",
      details: error.response?.data || error.message,
    }, { status: 500 });
  }
}