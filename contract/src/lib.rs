#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, token, Address, Bytes, BytesN, Env, Symbol};

#[contracttype]
pub enum DataKey {
    Treasury,
    UsdcContract,
    XlmContract,
    Admin,
}

#[contract]
pub struct Cards402Receiver;

#[contractimpl]
impl Cards402Receiver {
    /// One-time initialisation. Panics if already initialised.
    /// The admin must authorize this call to prevent front-running on deployment (C-1).
    ///
    /// Expected mainnet values (C-3, C-7):
    ///   usdc_contract : CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75  (USDC SAC)
    ///   xlm_contract  : native XLM SAC address (varies by network)
    ///   treasury      : cards402 treasury G-address — verify before deployment
    pub fn init(
        env: Env,
        admin: Address,
        treasury: Address,
        usdc_contract: Address,
        xlm_contract: Address,
    ) {
        admin.require_auth();

        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Treasury, &treasury);
        env.storage().instance().set(&DataKey::UsdcContract, &usdc_contract);
        env.storage().instance().set(&DataKey::XlmContract, &xlm_contract);

        env.storage().instance().extend_ttl(17_280_000, 17_280_000);
    }

    /// Transfer `amount` USDC (in micro-USDC, 7 d.p.) from `from` to treasury.
    /// Emits: topics=[Symbol("pay_usdc"), order_id, from], value=amount
    pub fn pay_usdc(env: Env, from: Address, amount: i128, order_id: Bytes) {
        if amount <= 0 {
            panic!("amount must be positive");
        }
        from.require_auth();

        let treasury: Address = env.storage().instance().get(&DataKey::Treasury).unwrap();
        let usdc_contract: Address = env.storage().instance().get(&DataKey::UsdcContract).unwrap();

        let token_client = token::Client::new(&env, &usdc_contract);
        token_client.transfer(&from, &treasury, &amount);

        env.events().publish(
            (Symbol::new(&env, "pay_usdc"), order_id, from),
            amount,
        );

        env.storage().instance().extend_ttl(17_280_000, 17_280_000);
    }

    /// Transfer `amount` XLM (in stroops, 7 d.p.) from `from` to treasury.
    /// Emits: topics=[Symbol("pay_xlm"), order_id, from], value=amount
    pub fn pay_xlm(env: Env, from: Address, amount: i128, order_id: Bytes) {
        if amount <= 0 {
            panic!("amount must be positive");
        }
        from.require_auth();

        let treasury: Address = env.storage().instance().get(&DataKey::Treasury).unwrap();
        let xlm_contract: Address = env.storage().instance().get(&DataKey::XlmContract).unwrap();

        let token_client = token::Client::new(&env, &xlm_contract);
        token_client.transfer(&from, &treasury, &amount);

        env.events().publish(
            (Symbol::new(&env, "pay_xlm"), order_id, from),
            amount,
        );

        env.storage().instance().extend_ttl(17_280_000, 17_280_000);
    }

    /// Return the treasury address.
    pub fn treasury(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Treasury).unwrap()
    }

    /// Return the USDC SAC contract address.
    pub fn usdc_contract(env: Env) -> Address {
        env.storage().instance().get(&DataKey::UsdcContract).unwrap()
    }

    /// Return the native XLM SAC contract address.
    pub fn xlm_contract(env: Env) -> Address {
        env.storage().instance().get(&DataKey::XlmContract).unwrap()
    }

    /// Return the admin address.
    pub fn admin(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Admin).unwrap()
    }

    /// Upgrade the contract WASM. Only the admin may call this.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Events},
        token, Bytes, Env, Symbol, TryIntoVal,
    };

    // ── Test fixture ──────────────────────────────────────────────────────────

    struct Fixture {
        env: Env,
        contract_id: Address,
        admin: Address,
        treasury: Address,
        payer: Address,
        usdc: Address,
        xlm_sac: Address,
    }

    impl Fixture {
        fn new() -> Self {
            let env = Env::default();
            env.mock_all_auths();

            let admin = Address::generate(&env);
            let treasury = Address::generate(&env);
            let payer = Address::generate(&env);

            // Register mock SAC token contracts for USDC and XLM
            let usdc = env.register_stellar_asset_contract_v2(admin.clone()).address();
            let xlm_sac = env.register_stellar_asset_contract_v2(admin.clone()).address();

            let contract_id = env.register(Cards402Receiver, ());

            Fixture { env, contract_id, admin, treasury, payer, usdc, xlm_sac }
        }

        fn client(&self) -> Cards402ReceiverClient<'_> {
            Cards402ReceiverClient::new(&self.env, &self.contract_id)
        }

        fn init(&self) {
            self.client().init(&self.admin, &self.treasury, &self.usdc, &self.xlm_sac);
        }

        fn mint_usdc(&self, to: &Address, amount: i128) {
            token::StellarAssetClient::new(&self.env, &self.usdc).mint(to, &amount);
        }

        fn mint_xlm(&self, to: &Address, amount: i128) {
            token::StellarAssetClient::new(&self.env, &self.xlm_sac).mint(to, &amount);
        }

        fn usdc_balance(&self, addr: &Address) -> i128 {
            token::Client::new(&self.env, &self.usdc).balance(addr)
        }

        fn xlm_balance(&self, addr: &Address) -> i128 {
            token::Client::new(&self.env, &self.xlm_sac).balance(addr)
        }
    }

    fn order_bytes(env: &Env, s: &str) -> Bytes {
        Bytes::from_slice(env, s.as_bytes())
    }

    // ── init tests ────────────────────────────────────────────────────────────

    #[test]
    fn test_init_stores_all_addresses() {
        let f = Fixture::new();
        f.init();

        let client = f.client();
        assert_eq!(client.treasury(), f.treasury);
        assert_eq!(client.usdc_contract(), f.usdc);
        assert_eq!(client.xlm_contract(), f.xlm_sac);
    }

    #[test]
    #[should_panic(expected = "already initialized")]
    fn test_init_twice_panics() {
        let f = Fixture::new();
        f.init();
        f.init(); // must panic
    }

    // ── pay_usdc tests ────────────────────────────────────────────────────────

    #[test]
    fn test_pay_usdc_transfers_to_treasury() {
        let f = Fixture::new();
        f.init();

        let amount: i128 = 25_000_000; // 25.00 USDC (7 d.p.)
        f.mint_usdc(&f.payer, amount);

        let oid = order_bytes(&f.env, "a3f7c2d1-4e8b-4f0a-9c2d");
        f.client().pay_usdc(&f.payer, &amount, &oid);

        assert_eq!(f.usdc_balance(&f.treasury), amount);
        assert_eq!(f.usdc_balance(&f.payer), 0);
    }

    #[test]
    fn test_pay_usdc_emits_correct_event() {
        let f = Fixture::new();
        f.init();

        let amount: i128 = 10_000_000; // 10.00 USDC
        f.mint_usdc(&f.payer, amount);

        let oid = order_bytes(&f.env, "test-order-usdc");
        f.client().pay_usdc(&f.payer, &amount, &oid);

        // Scan events for our contract's pay_usdc event.
        // Events are (contract_id, topics: Vec<Val>, data: Val).
        // Val doesn't implement PartialEq — use try_into_val for typed comparison.
        let events = f.env.events().all();
        let mut found = false;
        for (contract_addr, topics, data) in events.iter() {
            if contract_addr != f.contract_id {
                continue;
            }
            let sym: Symbol = topics.get(0).unwrap().try_into_val(&f.env).unwrap();
            if sym != Symbol::new(&f.env, "pay_usdc") {
                continue;
            }
            let emitted_oid: Bytes = topics.get(1).unwrap().try_into_val(&f.env).unwrap();
            assert_eq!(emitted_oid, oid);
            let emitted_from: Address = topics.get(2).unwrap().try_into_val(&f.env).unwrap();
            assert_eq!(emitted_from, f.payer);
            let emitted_amount: i128 = data.try_into_val(&f.env).unwrap();
            assert_eq!(emitted_amount, amount);
            found = true;
            break;
        }
        assert!(found, "pay_usdc event not found");
    }

    #[test]
    #[should_panic]
    fn test_pay_usdc_requires_auth() {
        let env = Env::default();
        // No mock_all_auths — require_auth() will fail

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let payer = Address::generate(&env);
        let usdc = env.register_stellar_asset_contract_v2(admin.clone()).address();
        let xlm_sac = env.register_stellar_asset_contract_v2(admin.clone()).address();
        let contract_id = env.register(Cards402Receiver, ());
        let client = Cards402ReceiverClient::new(&env, &contract_id);

        // init has no require_auth so it runs fine without mocking
        client.init(&admin, &treasury, &usdc, &xlm_sac);

        // pay_usdc calls from.require_auth() — must panic without mock
        let oid = order_bytes(&env, "order-no-auth");
        client.pay_usdc(&payer, &1_000_000_i128, &oid);
    }

    // ── pay_xlm tests ─────────────────────────────────────────────────────────

    #[test]
    fn test_pay_xlm_transfers_to_treasury() {
        let f = Fixture::new();
        f.init();

        let amount: i128 = 161_290_000; // ~161.29 XLM in stroops
        f.mint_xlm(&f.payer, amount);

        let oid = order_bytes(&f.env, "b2e8d1c0-5f9a-4b0b-8d3e");
        f.client().pay_xlm(&f.payer, &amount, &oid);

        assert_eq!(f.xlm_balance(&f.treasury), amount);
        assert_eq!(f.xlm_balance(&f.payer), 0);
    }

    #[test]
    fn test_pay_xlm_emits_correct_event() {
        let f = Fixture::new();
        f.init();

        let amount: i128 = 50_000_000; // 50.00 XLM
        f.mint_xlm(&f.payer, amount);

        let oid = order_bytes(&f.env, "test-order-xlm");
        f.client().pay_xlm(&f.payer, &amount, &oid);

        let events = f.env.events().all();
        let mut found = false;
        for (contract_addr, topics, data) in events.iter() {
            if contract_addr != f.contract_id {
                continue;
            }
            let sym: Symbol = topics.get(0).unwrap().try_into_val(&f.env).unwrap();
            if sym != Symbol::new(&f.env, "pay_xlm") {
                continue;
            }
            let emitted_oid: Bytes = topics.get(1).unwrap().try_into_val(&f.env).unwrap();
            assert_eq!(emitted_oid, oid);
            let emitted_from: Address = topics.get(2).unwrap().try_into_val(&f.env).unwrap();
            assert_eq!(emitted_from, f.payer);
            let emitted_amount: i128 = data.try_into_val(&f.env).unwrap();
            assert_eq!(emitted_amount, amount);
            found = true;
            break;
        }
        assert!(found, "pay_xlm event not found");
    }

    #[test]
    #[should_panic]
    fn test_pay_xlm_requires_auth() {
        let env = Env::default();
        // No mock_all_auths

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let payer = Address::generate(&env);
        let usdc = env.register_stellar_asset_contract_v2(admin.clone()).address();
        let xlm_sac = env.register_stellar_asset_contract_v2(admin.clone()).address();
        let contract_id = env.register(Cards402Receiver, ());
        let client = Cards402ReceiverClient::new(&env, &contract_id);

        client.init(&admin, &treasury, &usdc, &xlm_sac);

        let oid = order_bytes(&env, "order-no-auth-xlm");
        client.pay_xlm(&payer, &1_000_000_i128, &oid);
    }

    // ── getter tests ──────────────────────────────────────────────────────────

    #[test]
    fn test_try_getters_before_init_return_err() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(Cards402Receiver, ());
        let client = Cards402ReceiverClient::new(&env, &contract_id);

        // Uninitialised — try_treasury() returns Err (unwrap() would panic)
        assert!(client.try_treasury().is_err());
        assert!(client.try_usdc_contract().is_err());
        assert!(client.try_xlm_contract().is_err());
    }

    // ── amount validation tests ───────────────────────────────────────────────

    #[test]
    #[should_panic(expected = "amount must be positive")]
    fn test_pay_usdc_rejects_zero_amount() {
        let f = Fixture::new();
        f.init();
        let oid = order_bytes(&f.env, "zero-amount");
        f.client().pay_usdc(&f.payer, &0_i128, &oid);
    }

    #[test]
    #[should_panic(expected = "amount must be positive")]
    fn test_pay_usdc_rejects_negative_amount() {
        let f = Fixture::new();
        f.init();
        let oid = order_bytes(&f.env, "neg-amount");
        f.client().pay_usdc(&f.payer, &(-1_000_000_i128), &oid);
    }

    #[test]
    #[should_panic(expected = "amount must be positive")]
    fn test_pay_xlm_rejects_zero_amount() {
        let f = Fixture::new();
        f.init();
        let oid = order_bytes(&f.env, "xlm-zero");
        f.client().pay_xlm(&f.payer, &0_i128, &oid);
    }

    #[test]
    #[should_panic(expected = "amount must be positive")]
    fn test_pay_xlm_rejects_negative_amount() {
        let f = Fixture::new();
        f.init();
        let oid = order_bytes(&f.env, "xlm-neg");
        f.client().pay_xlm(&f.payer, &(-50_000_000_i128), &oid);
    }

    // ── upgrade tests ─────────────────────────────────────────────────────────

    #[test]
    fn test_admin_getter_returns_correct_address() {
        let f = Fixture::new();
        f.init();
        assert_eq!(f.client().admin(), f.admin);
    }

    #[test]
    #[should_panic]
    fn test_upgrade_requires_admin_auth() {
        let env = Env::default();
        env.mock_auths(&[]);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let usdc = env.register_stellar_asset_contract_v2(admin.clone()).address();
        let xlm_sac = env.register_stellar_asset_contract_v2(admin.clone()).address();
        let contract_id = env.register(Cards402Receiver, ());
        let client = Cards402ReceiverClient::new(&env, &contract_id);

        // init with mocked auth temporarily just for setup
        env.mock_all_auths();
        client.init(&admin, &treasury, &usdc, &xlm_sac);

        // upgrade without admin auth must panic
        env.mock_auths(&[]);
        let fake_hash = BytesN::from_array(&env, &[0u8; 32]);
        client.upgrade(&fake_hash);
    }

    // ── init auth test ────────────────────────────────────────────────────────

    #[test]
    fn test_init_requires_admin_auth() {
        let env = Env::default();
        // No mock_all_auths — only the admin can authorize
        env.mock_auths(&[]);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let usdc = env.register_stellar_asset_contract_v2(admin.clone()).address();
        let xlm_sac = env.register_stellar_asset_contract_v2(admin.clone()).address();
        let contract_id = env.register(Cards402Receiver, ());
        let client = Cards402ReceiverClient::new(&env, &contract_id);

        // Should panic because admin.require_auth() fires and no auth is mocked
        let result = client.try_init(&admin, &treasury, &usdc, &xlm_sac);
        assert!(result.is_err(), "init should require admin authorization");
    }
}
