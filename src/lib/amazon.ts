import axios from 'axios';

const SP_API_ENDPOINT = 'https://sellingpartnerapi-eu.amazon.com'; // Change to -eu or -fe if needed

// Official Amazon Marketplace ID for the United Kingdom
const UK_MARKETPLACE_ID = 'A1F83G8C2ARO7P';

/**
 * 1. Get the temporary Access Token from Amazon
 */
export async function getAccessToken() {
  try {
    const response = await axios.post('https://api.amazon.com/auth/o2/token', {
      grant_type: 'refresh_token',
      refresh_token: process.env.SP_API_REFRESH_TOKEN,
      client_id: process.env.SP_API_CLIENT_ID,
      client_secret: process.env.SP_API_CLIENT_SECRET,
    });
    return response.data.access_token;
  } catch (error) {
    console.error('Amazon Auth Error:', error);
    throw new Error('Failed to authenticate with Amazon');
  }
}

/**
 * 2. Fetch Live Inventory from Amazon
 */
export async function fetchAmazonInventory() {
  const accessToken = await getAccessToken();
  
  // We call the 'getInventorySummaries' endpoint
  // details=true gives us the breakdown of Inbound and Reserved stock
  const response = await axios.get(`${SP_API_ENDPOINT}/fba/inventory/v1/summaries`, {
    headers: { 'x-amz-access-token': accessToken },
    params: {
      details: true,
      granularityType: 'Marketplace',
      granularityId: UK_MARKETPLACE_ID, // Standard ID UK/EU.
      marketplaceIds: UK_MARKETPLACE_ID,
    },
  });

  const inventoryList = response.data.payload.inventorySummaries;

  return inventoryList.map((item: any) => {
    // We map Amazon's complex data to a simpler format for our app
    return {
      sku: item.sellerSku,
      asin: item.asin,
      product_name: item.productName,
      // 'fulfillable' = Ready to sell
      fulfillable: item.inventoryDetails?.fulfillableQuantity || 0,
      // 'inbound' = Sent to Amazon but still being processed/received
      inbound: (item.inventoryDetails?.inboundWorkingQuantity || 0) + 
               (item.inventoryDetails?.inboundShippedQuantity || 0) + 
               (item.inventoryDetails?.inboundReceivingQuantity || 0),
      // 'reserved' = Pending orders or warehouse transfer
      reserved: item.inventoryDetails?.reservedQuantity?.totalReservedQuantity || 0,
    };
  });
}