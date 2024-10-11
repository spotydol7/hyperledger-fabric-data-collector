const express = require('express');
const mysql = require('mysql2');
const nano = require('nano')('http://admin:password@localhost:5984'); // CouchDB URL with credentials
const bodyParser = require('body-parser');
const session = require('express-session');
const bcrypt = require('bcrypt');
const app = express();
const { exec } = require('child_process');
const port = 3001;
const { Gateway, Wallets } = require('fabric-network');
const FabricCAServices = require('fabric-ca-client');
const fs = require('fs');
const path = require('path');
const registerUser = require('./server/registerUser');

// Fabric Network 연결 Configuration
const ccpPath = path.resolve(__dirname, '../config-files/connection-org1.json'); // 연결 프로파일 파일의 경로
const walletPath = path.join(process.cwd(), 'wallet'); // 지갑 경로

// CouchDB 데이터베이스 선택
const chaincodeDB = nano.db.use('smart_contract_pool'); // 'chaincode_db'는 CouchDB 데이터베이스 이름

// MySQL 데이터베이스 연결 설정
const db = mysql.createConnection({
  host: 'localhost',
  user: 'root',
  password: 'password',
  database: 'userinfo',
  port: 3306
});

db.connect(err => {
  if (err) {
    console.error('Error connecting to MySQL:', err);
    return;
  }
  console.log('Connected to MySQL');
});

// 세션 설정
app.use(session({
  secret: 'your-secret-key', // 세션 암호화에 사용할 키
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // HTTPS 사용 시 true로 설정
}));

// 정적 파일 제공
app.use(express.static(path.join(__dirname, 'build')));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// 루트 경로에 대한 요청을 React 앱의 index.html로 리디렉션
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '/src/MainPage.js'));
});

// -------------------------블록체인 네트워크 연결--------------------------------
async function connectToNetwork() {
  try {
    // 1. 연결 프로필 파일 로드
    const ccp = JSON.parse(fs.readFileSync(ccpPath, 'utf8'));

    // 2. 지갑 생성 또는 가져오기
    const wallet = await Wallets.newFileSystemWallet(walletPath);
    console.log(`Wallet path: ${walletPath}`);

    // 3. 사용자 인증서 확인
    const identity = await wallet.get('appUser');
    if (!identity) {
      console.log('An identity for the user "appUser" does not exist in the wallet');
      console.log('Run the registerUser.js application before retrying');
      return null;
    }

    // 4. Gateway 인스턴스 생성
    const gateway = new Gateway();
    await gateway.connect(ccp, {
      wallet,
      identity: 'appUser',
      discovery: { enabled: true, asLocalhost: true },
    });

    // 5. 네트워크와 체인코드 참조 가져오기
    const network = await gateway.getNetwork('mychannel'); // 채널 이름
    const contract = network.getContract('mycc'); // 체인코드 이름

    //연결 성공 메세지
    console.log('Successfully connected to Hyperledger Fabric network and fetched contract.');

    return contract; // 체인코드 참조 반환
  } catch (error) {
    console.error(`Failed to connect to network: ${error}`);
    return null;
  }
}

connectToNetwork().then(contract => {
  if (contract) {
    console.log('Fabric network is ready for transactions.');
  }
});
// ---------------------------로그인 관련--------------------------------------

// 회원가입 API
app.post('/api/register', async (req, res) => {
  const { id, password, name, phonenumber } = req.body;
  const hashedPassword = await bcrypt.hash(password, 10); // 비밀번호 해싱
  const query = 'INSERT INTO users (id, password, name, phonenumber) VALUES (?, ?, ?, ?)';

  db.query(query, [id, hashedPassword, name, phonenumber], async (err, result) => {
    if (err) {
      console.error('Error during user registration:', err);
      return res.status(500).json({ error: 'Failed to register user', details: err });
    }
    /*try {
      // registerUser 함수 호출 및 처리
      await registerUser(organization, id, password, name, phonenumber);
      return res.json({ message: 'User registered successfully', result });
    } catch (registerError) {
      console.error('Error during registering user in blockchain:', registerError);
      return res.status(500).json({ error: 'Failed to register user in blockchain', details: registerError.message });
    }*/
  });
});

/*
app.post('/api/register', async (req, res) => {
  const { organization, id, username, name } = req.body;

  if (!['org1', 'org2'].includes(organization)) {
      return res.status(400).send({ error: 'Invalid organization' });
  }

  try {
      await registerUser(organization, id, username, name);
      res.status(200).send({ message: 'User registered successfully' });
  } catch (error) {
      res.status(500).send({ error: `Failed to register user: ${error.message}` });
  }
});
*/
// 로그인 API
// 로그인 API
app.post('/api/login', (req, res) => {
  const { id, password } = req.body;
  const query = 'SELECT * FROM users WHERE id = ?';
  db.query(query, [id], async (err, results) => {
    if (err) {
      console.error('Error during login:', err);
      res.status(500).json({ error: 'Failed to login', details: err });
      return;
    }
    if (results.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const user = results[0];
    // 비밀번호 확인
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    // 로그인 성공, 세션에 사용자 정보 저장
    req.session.user = {
      id: user.id,
      isAdmin: user.isAdmin // 관리자 여부 저장
    };
    res.json({ message: 'Login successful', isAdmin: user.isAdmin });
  });
});

// 로그아웃 API
app.post('/api/logout', (req, res) => {
  // 세션을 파괴하여 로그아웃합니다.
  req.session.destroy(err => {
    if (err) {
      return res.status(500).json({ error: 'Failed to logout' });
    }
    res.json({ message: 'Logged out successfully' });
  });
});

// 로그인 상태 확인 API
app.get('/api/me', (req, res) => {
  // 사용자 세션 또는 토큰에서 로그인 정보를 가져옵니다.
  // 예를 들어, 세션을 사용하여 로그인 상태를 확인합니다.
  // (여기서는 간단하게 세션 정보를 사용한다고 가정합니다.)
  const user = req.session.user; // 세션에서 사용자 정보를 가져옵니다.
  
  if (user) {
    res.json({ loggedIn: true, id: user.id, isAdmin: user.isAdmin });
  } else {
    res.json({ loggedIn: false });
  }
});

// ---------------------------로그인 관련--------------------------------------
// ---------------------------데이터 수집 관련----------------------------------

// 투표 데이터 수집 API
app.post('/api/collect-vote-data', (req, res) => {
  const { candidates } = req.body;
  const candidateEntries = Object.values(candidates);

  const query = 'INSERT INTO vote_data (symbolNumber, name) VALUES ?';
  const values = candidateEntries.map(candidate => [candidate.symbolNumber, candidate.name]);

  db.query(query, [values], (err, result) => {
    if (err) {
      console.error('Error collecting vote data:', err);
      res.status(500).json({ error: 'Failed to collect vote data', details: err });
      return;
    }
    res.json({ message: 'Vote data collected successfully', result });
  });
});

// 지역별 온도 데이터 수집 API
app.post('/api/collect-temperature-data', (req, res) => {
  const { regions } = req.body;
  const regionEntries = Object.values(regions);

  const query = 'INSERT INTO temperature_data (region) VALUES ?';
  const values = regionEntries.map(region => [region.region]);

  db.query(query, [values], (err, result) => {
    if (err) {
      console.error('Error collecting temperature data:', err);
      res.status(500).json({ error: 'Failed to collect temperature data', details: err });
      return;
    }
    res.json({ message: 'Temperature data collected successfully', result });
  });
});

// 설문 데이터 수집 API
app.post('/api/collect-survey-data', (req, res) => {
  const { questions } = req.body;
  const questionEntries = Object.values(questions);

  const query = 'INSERT INTO survey_data (questionNumber, content) VALUES ?';
  const values = questionEntries.map(question => [question.questionNumber, question.content]);

  db.query(query, [values], (err, result) => {
    if (err) {
      console.error('Error collecting survey data:', err);
      res.status(500).json({ error: 'Failed to collect survey data', details: err });
      return;
    }
    res.json({ message: 'Survey data collected successfully', result });
  });
});

// 데이터 수집 API
app.post('/api/collect-data', (req, res) => {
  const { data } = req.body;
  
  // 데이터베이스에 데이터를 저장하는 로직을 추가하세요.
  // 예를 들어, MySQL에 데이터를 저장할 수 있습니다.
  const query = 'INSERT INTO collected_data (data) VALUES (?)';
  db.query(query, [data], (err, result) => {
    if (err) {
      console.error('Error collecting data:', err);
      res.status(500).json({ error: 'Failed to collect data', details: err });
      return;
    }
    res.json({ message: 'Data collected successfully', result });
  });
});

// 데이터 수집 참여 API
app.post('/api/participate-data-collection', (req, res) => {
  const { feedback } = req.body;
  
  // 데이터베이스에 피드백을 저장하는 로직을 추가하세요.
  // 예를 들어, MySQL에 피드백을 저장할 수 있습니다.
  const query = 'INSERT INTO feedback (feedback) VALUES (?)';
  db.query(query, [feedback], (err, result) => {
    if (err) {
      console.error('Error submitting feedback:', err);
      res.status(500).json({ error: 'Failed to submit feedback', details: err });
      return;
    }
    res.json({ message: 'Feedback submitted successfully', result });
  });
});

// ---------------------------데이터 수집 관련----------------------------------

// 관리자 인증 미들웨어
function adminAuth(req, res, next) {
  if (req.session.user && req.session.user.isAdmin) {
    return next();
  }
  res.status(403).json({ error: 'Access denied' });
}

// 스마트 컨트랙트 모니터링 구현
app.get('/api/monitor-smart-contracts', (req, res) => {
  const command = 'docker logs peer0.org1.example.com';

  exec(command, (err, stdout, stderr) => {
    if (err) {
      console.error('명령어 실행 중 오류 발생:', err);
      return res.status(500).json({ error: 'Internal Server Error' });
    }

    if (stderr) {
      console.error('표준 오류:', stderr);
      return res.status(500).json({ error: 'Internal Server Error' });
    }

    // 로그를 JSON 형식으로 변환
    const logs = stdout.split('\n').map(line => ({ message: line }));

    res.json(logs);
  });
});

// 모든 문서의 _id 조회 API
app.get('/api/templates', adminAuth, async (req, res) => {
  try {
    const ids = await chaincodeDB.list({ include_docs: false });
    res.json(ids.rows.map(row => row.id));
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve templates from CouchDB', details: error });
  }
});

// 특정 문서 조회 API
app.get('/api/templates/:id', adminAuth, async (req, res) => {
  const id = req.params.id;
  try {
    const doc = await chaincodeDB.get(id);
    res.json(doc);
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve template from CouchDB', details: error });
  }
});

// 특정 문서 수정 API
app.post('/api/templates/:id', adminAuth, async (req, res) => {
  const id = req.params.id;
  const newContent = req.body.content;
  try {
    const doc = await chaincodeDB.get(id);
    doc.content = newContent;
    const response = await chaincodeDB.insert(doc);
    res.json({ message: 'Template updated successfully', response });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update template in CouchDB', details: error });
  }
});

// 스마트 컨트랙트 배포 API
app.post('/api/deploy-smart-contract', adminAuth, async (req, res) => {
  const { templateId } = req.body;

  try {
    const template = await chaincodeDB.get(templateId);

    // 스마트 컨트랙트 배포 로직을 구현
    // Fabric 네트워크를 통해 실제 배포를 수행

    const wallet = await Wallets.newFileSystemWallet(walletPath);
    const gateway = new Gateway();

    await gateway.connect(ccpPath, {
      wallet,
      identity: 'admin',
      discovery: { enabled: true, asLocalhost: true }
    });

    const network = await gateway.getNetwork('mychannel');
    const contract = network.getContract('mychaincode');

    await contract.submitTransaction('deployContract', templateId, JSON.stringify(template));

    await gateway.disconnect();

    res.json({ message: 'Smart contract deployed successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to deploy smart contract', details: error });
  }
});

// ---------------------------데이터 조회(org1 수집자) 체인코드 호출 api----------------------------------

app.use(bodyParser.json());

// 하이퍼레저 패브릭 네트워크와 연결하는 함수
async function getDataFromContract(funcName, key = null) {
    try {
        const ccpPath = path.resolve(__dirname, 'connection-org1.json');
        const ccp = JSON.parse(fs.readFileSync(ccpPath, 'utf8'));

        const walletPath = path.join(process.cwd(), 'wallet');
        const wallet = await Wallets.newFileSystemWallet(walletPath);

        const identity = await wallet.get('appUser');
        if (!identity) {
            console.log('Identity for the user "appUser" does not exist in the wallet');
            return;
        }

        const gateway = new Gateway();
        await gateway.connect(ccp, { wallet, identity: 'appUser', discovery: { enabled: true, asLocalhost: true } });

        const network = await gateway.getNetwork('mychannel');
        const contract = network.getContract('environmentContract');

        let result;
        if (key) {
            result = await contract.evaluateTransaction(funcName, key);
        } else {
            result = await contract.evaluateTransaction(funcName);
        }

        console.log(`Transaction result for ${funcName}: ${result.toString()}`);
        await gateway.disconnect();

        return result.toString();
    } catch (error) {
        console.error(`Failed to evaluate transaction: ${error}`);
        throw error;
    }
}

// 수질 데이터 전체 조회 API
app.get('/water-quality', async (req, res) => {
    try {
        const result = await getDataFromContract('GetAllWaterQualityData');
        res.status(200).send(result);
    } catch (error) {
        res.status(500).send('Error fetching water quality data');
    }
});

// 수질 데이터 단일 조회 API
app.get('/water-quality/:key', async (req, res) => {
  const key = req.params.key;
    try {
        const result = await getDataFromContract('GetSingleWaterQualityData', key);
        res.status(200).send(result);
    } catch (error) {
      res.status(500).send(`Error fetching water quality data with key: ${key}`);
    }
});

// 대기질 데이터 전체 조회 API
app.get('/air-quality', async (req, res) => {
    try {
        const result = await getDataFromContract('GetAllAirQualityData');
        res.status(200).send(result);
    } catch (error) {
        res.status(500).send('Error fetching air quality data');
    }
});

// 대기질 데이터 단일 조회 API
app.get('/air-quality/:key', async (req, res) => {
  const key = req.params.key;
    try {
        const result = await getDataFromContract('GetSingleAirQualityData', key);
        res.status(200).send(result);
    } catch (error) {
        res.status(500).send(`Error fetching air quality data with key: ${key}`);
    }
});

// 기상 데이터 전체 조회 API
app.get('/weather', async (req, res) => {
    try {
        const result = await getDataFromContract('GetAllWeatherData');
        res.status(200).send(result);
    } catch (error) {
        res.status(500).send('Error fetching weather data');
    }
});

// 기상 데이터 단일 조회 API
app.get('/weather/:key', async (req, res) => {
  const key = req.params.key;
    try {
        const result = await getDataFromContract('GetSingleWeatherData', key);
        res.status(200).send(result);
    } catch (error) {
        res.status(500).send(`Error fetching weather data with key: ${key}`);
    }
});

// 서버 시작
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
