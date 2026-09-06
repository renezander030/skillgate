package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/tuneinsight/lattigo/v6/core/rlwe"
	"github.com/tuneinsight/lattigo/v6/schemes/bgv"
)

const (
	schemaPrivate     = "skillgate.fhe-metrics-secret.v1"
	publicKeySchema   = "skillgate.fhe-metrics-public.v1"
	metricSchema      = "skillgate.fhe-metric.v1"
	aggregateSchema   = "skillgate.fhe-metrics-aggregate.v1"
	suite             = "LATTIGO_BGV_128_N12_QP109"
	minRepositories   = 3
	maxRepositories   = 128
	maxGatesPerReport = 256
	maxBinaryBytes    = 8 << 20
)

type secretKeyFile struct {
	Schema          string `json:"schema"`
	Suite           string `json:"suite"`
	KeyID           string `json:"key_id"`
	SecretKeyBase64 string `json:"secret_key_base64"`
	PublicKeyBase64 string `json:"public_key_base64"`
}

type publicKeyFile struct {
	Schema          string `json:"schema"`
	Suite           string `json:"suite"`
	KeyID           string `json:"key_id"`
	PublicKeyBase64 string `json:"public_key_base64"`
}

// encryptedMetric contains two encrypted slots: passed gates and total gates.
// The aggregator sees neither value.
type encryptedMetric struct {
	Schema               string `json:"schema"`
	Suite                string `json:"suite"`
	KeyID                string `json:"key_id"`
	ContextID            string `json:"context_id"`
	RepositoryCommitment string `json:"repository_commitment"`
	CiphertextBase64     string `json:"ciphertext_base64"`
	CiphertextBytes      int    `json:"ciphertext_bytes"`
}

type encryptedAggregate struct {
	Schema           string   `json:"schema"`
	Suite            string   `json:"suite"`
	KeyID            string   `json:"key_id"`
	ContextID        string   `json:"context_id"`
	Repositories     int      `json:"repositories"`
	Contributors     []string `json:"contributors"`
	CiphertextBase64 string   `json:"ciphertext_base64"`
	CiphertextBytes  int      `json:"ciphertext_bytes"`
}

type aggregateResult struct {
	PassedGates  int
	TotalGates   int
	Repositories int
}

type checkResult struct {
	Passed  *bool `json:"passed"`
	Results []struct {
		OK *bool `json:"ok"`
	} `json:"results"`
}

func fheParameters() (bgv.Parameters, error) {
	return bgv.NewParametersFromLiteral(bgv.ParametersLiteral{
		LogN:             12,
		LogQ:             []int{39, 31},
		LogP:             []int{39},
		PlaintextModulus: 0x10001,
	})
}

func generateFHEKeys() (secretKeyFile, publicKeyFile, error) {
	params, err := fheParameters()
	if err != nil {
		return secretKeyFile{}, publicKeyFile{}, err
	}
	sk, pk := rlwe.NewKeyGenerator(params).GenKeyPairNew()
	skBytes, err := sk.MarshalBinary()
	if err != nil {
		return secretKeyFile{}, publicKeyFile{}, fmt.Errorf("encode secret key: %w", err)
	}
	pkBytes, err := pk.MarshalBinary()
	if err != nil {
		return secretKeyFile{}, publicKeyFile{}, fmt.Errorf("encode public key: %w", err)
	}
	id := fheKeyID(pkBytes)
	public := publicKeyFile{Schema: publicKeySchema, Suite: suite, KeyID: id, PublicKeyBase64: base64.StdEncoding.EncodeToString(pkBytes)}
	secret := secretKeyFile{
		Schema: schemaPrivate, Suite: suite, KeyID: id,
		SecretKeyBase64: base64.StdEncoding.EncodeToString(skBytes), PublicKeyBase64: public.PublicKeyBase64,
	}
	return secret, public, nil
}

func encryptCheckReport(public publicKeyFile, context, repositoryToken string, checkJSON []byte) (encryptedMetric, error) {
	params, pk, err := loadFHEPublicKey(public)
	if err != nil {
		return encryptedMetric{}, err
	}
	var report checkResult
	if err := json.Unmarshal(checkJSON, &report); err != nil {
		return encryptedMetric{}, fmt.Errorf("decode skillgate check JSON: %w", err)
	}
	if len(report.Results) == 0 {
		return encryptedMetric{}, errors.New("skillgate report contains no gate results")
	}
	if len(report.Results) > maxGatesPerReport {
		return encryptedMetric{}, fmt.Errorf("skillgate report exceeds %d gates", maxGatesPerReport)
	}
	passed := 0
	for i, result := range report.Results {
		if result.OK == nil {
			return encryptedMetric{}, fmt.Errorf("skillgate report result %d has no verdict", i+1)
		}
		if *result.OK {
			passed++
		}
	}
	if report.Passed == nil {
		return encryptedMetric{}, errors.New("skillgate report has no top-level verdict")
	}
	if *report.Passed != (passed == len(report.Results)) {
		return encryptedMetric{}, errors.New("skillgate report verdict is inconsistent with its gate results")
	}
	contextID, err := fheCommitment("skillgate:fhe-metrics:context:v1", context)
	if err != nil {
		return encryptedMetric{}, fmt.Errorf("context: %w", err)
	}
	repositoryID, err := fheCommitment("skillgate:fhe-metrics:repository:v1", repositoryToken)
	if err != nil {
		return encryptedMetric{}, fmt.Errorf("repository token: %w", err)
	}
	values := make([]uint64, params.MaxSlots())
	values[0], values[1], values[2] = uint64(passed), uint64(len(report.Results)), 1
	plaintext := bgv.NewPlaintext(params, params.MaxLevel())
	if err := bgv.NewEncoder(params).Encode(values, plaintext); err != nil {
		return encryptedMetric{}, fmt.Errorf("encode gate metrics: %w", err)
	}
	ciphertext, err := rlwe.NewEncryptor(params, pk).EncryptNew(plaintext)
	if err != nil {
		return encryptedMetric{}, fmt.Errorf("encrypt gate metrics: %w", err)
	}
	encoded, err := ciphertext.MarshalBinary()
	if err != nil {
		return encryptedMetric{}, fmt.Errorf("encode ciphertext: %w", err)
	}
	return encryptedMetric{
		Schema: metricSchema, Suite: suite, KeyID: public.KeyID,
		ContextID: contextID, RepositoryCommitment: repositoryID,
		CiphertextBase64: base64.StdEncoding.EncodeToString(encoded), CiphertextBytes: len(encoded),
	}, nil
}

func aggregateMetrics(public publicKeyFile, context string, metrics []encryptedMetric) (encryptedAggregate, error) {
	if len(metrics) < minRepositories {
		return encryptedAggregate{}, fmt.Errorf("at least %d repository metrics are required; smaller groups do not provide meaningful contributor privacy", minRepositories)
	}
	if len(metrics) > maxRepositories {
		return encryptedAggregate{}, fmt.Errorf("too many repository metrics: maximum is %d", maxRepositories)
	}
	params, _, err := loadFHEPublicKey(public)
	if err != nil {
		return encryptedAggregate{}, err
	}
	contextID, err := fheCommitment("skillgate:fhe-metrics:context:v1", context)
	if err != nil {
		return encryptedAggregate{}, fmt.Errorf("context: %w", err)
	}
	seen := make(map[string]struct{}, len(metrics))
	contributors := make([]string, 0, len(metrics))
	var total *rlwe.Ciphertext
	evaluator := bgv.NewEvaluator(params, nil)
	for i, metric := range metrics {
		if metric.Schema != metricSchema || metric.Suite != suite {
			return encryptedAggregate{}, fmt.Errorf("metric %d has an unsupported schema or suite", i+1)
		}
		if metric.KeyID != public.KeyID {
			return encryptedAggregate{}, fmt.Errorf("metric %d key ID does not match the pinned public key", i+1)
		}
		if metric.ContextID != contextID {
			return encryptedAggregate{}, fmt.Errorf("metric %d context does not match", i+1)
		}
		if !isFHEHash(metric.RepositoryCommitment) {
			return encryptedAggregate{}, fmt.Errorf("metric %d has an invalid repository commitment", i+1)
		}
		if _, duplicate := seen[metric.RepositoryCommitment]; duplicate {
			return encryptedAggregate{}, fmt.Errorf("metric %d repeats repository commitment %s", i+1, metric.RepositoryCommitment)
		}
		seen[metric.RepositoryCommitment] = struct{}{}
		contributors = append(contributors, metric.RepositoryCommitment)
		ciphertext, err := decodeFHECiphertext(params, metric.CiphertextBase64, metric.CiphertextBytes)
		if err != nil {
			return encryptedAggregate{}, fmt.Errorf("metric %d: %w", i+1, err)
		}
		if total == nil {
			total = ciphertext.CopyNew()
		} else if total, err = evaluator.AddNew(total, ciphertext); err != nil {
			return encryptedAggregate{}, fmt.Errorf("add metric %d: %w", i+1, err)
		}
	}
	encoded, err := total.MarshalBinary()
	if err != nil {
		return encryptedAggregate{}, fmt.Errorf("encode encrypted aggregate: %w", err)
	}
	return encryptedAggregate{
		Schema: aggregateSchema, Suite: suite, KeyID: public.KeyID, ContextID: contextID,
		Repositories: len(metrics), Contributors: contributors,
		CiphertextBase64: base64.StdEncoding.EncodeToString(encoded), CiphertextBytes: len(encoded),
	}, nil
}

func decryptAggregate(secret secretKeyFile, context string, aggregate encryptedAggregate) (aggregateResult, error) {
	params, sk, err := loadFHESecretKey(secret)
	if err != nil {
		return aggregateResult{}, err
	}
	contextID, err := fheCommitment("skillgate:fhe-metrics:context:v1", context)
	if err != nil {
		return aggregateResult{}, fmt.Errorf("context: %w", err)
	}
	if aggregate.Schema != aggregateSchema || aggregate.Suite != suite {
		return aggregateResult{}, errors.New("unsupported encrypted aggregate schema or suite")
	}
	if aggregate.KeyID != secret.KeyID {
		return aggregateResult{}, errors.New("aggregate key ID does not match the secret key")
	}
	if aggregate.ContextID != contextID {
		return aggregateResult{}, errors.New("aggregate context does not match")
	}
	if aggregate.Repositories < minRepositories || aggregate.Repositories > maxRepositories || len(aggregate.Contributors) != aggregate.Repositories {
		return aggregateResult{}, errors.New("aggregate repository count is invalid")
	}
	seen := make(map[string]struct{}, len(aggregate.Contributors))
	for _, contributor := range aggregate.Contributors {
		if !isFHEHash(contributor) {
			return aggregateResult{}, errors.New("aggregate contains an invalid contributor commitment")
		}
		if _, duplicate := seen[contributor]; duplicate {
			return aggregateResult{}, errors.New("aggregate repeats a contributor commitment")
		}
		seen[contributor] = struct{}{}
	}
	ciphertext, err := decodeFHECiphertext(params, aggregate.CiphertextBase64, aggregate.CiphertextBytes)
	if err != nil {
		return aggregateResult{}, err
	}
	values := make([]uint64, params.MaxSlots())
	if err := bgv.NewEncoder(params).Decode(rlwe.NewDecryptor(params, sk).DecryptNew(ciphertext), values); err != nil {
		return aggregateResult{}, fmt.Errorf("decrypt aggregate: %w", err)
	}
	passed, total, repositories := values[0], values[1], values[2]
	if repositories != uint64(aggregate.Repositories) {
		return aggregateResult{}, errors.New("encrypted repository count does not match the aggregate metadata")
	}
	if total == 0 || passed > total || total > repositories*maxGatesPerReport {
		return aggregateResult{}, errors.New("decrypted gate totals are impossible")
	}
	for _, value := range values[3:] {
		if value != 0 {
			return aggregateResult{}, errors.New("encrypted aggregate contains unexpected data outside the metric slots")
		}
	}
	passedGates := int(passed) // #nosec G115 -- bounded by maxRepositories and maxGatesPerReport above.
	totalGates := int(total)   // #nosec G115 -- bounded by maxRepositories and maxGatesPerReport above.
	return aggregateResult{PassedGates: passedGates, TotalGates: totalGates, Repositories: aggregate.Repositories}, nil
}

func loadFHEPublicKey(file publicKeyFile) (bgv.Parameters, *rlwe.PublicKey, error) {
	params, err := fheParameters()
	if err != nil {
		return bgv.Parameters{}, nil, err
	}
	if file.Schema != publicKeySchema || file.Suite != suite {
		return bgv.Parameters{}, nil, errors.New("unsupported FHE public-key schema or suite")
	}
	encoded, err := decodeFHEBase64(file.PublicKeyBase64, "public key")
	if err != nil {
		return bgv.Parameters{}, nil, err
	}
	if fheKeyID(encoded) != file.KeyID {
		return bgv.Parameters{}, nil, errors.New("public-key ID mismatch")
	}
	key := rlwe.NewPublicKey(params)
	if err := key.UnmarshalBinary(encoded); err != nil {
		return bgv.Parameters{}, nil, fmt.Errorf("decode public key: %w", err)
	}
	return params, key, nil
}

func loadFHESecretKey(file secretKeyFile) (bgv.Parameters, *rlwe.SecretKey, error) {
	params, err := fheParameters()
	if err != nil {
		return bgv.Parameters{}, nil, err
	}
	if file.Schema != schemaPrivate || file.Suite != suite {
		return bgv.Parameters{}, nil, errors.New("unsupported FHE secret-key schema or suite")
	}
	publicBytes, err := decodeFHEBase64(file.PublicKeyBase64, "public key")
	if err != nil {
		return bgv.Parameters{}, nil, err
	}
	if fheKeyID(publicBytes) != file.KeyID {
		return bgv.Parameters{}, nil, errors.New("secret file's public-key ID mismatch")
	}
	secretBytes, err := decodeFHEBase64(file.SecretKeyBase64, "secret key")
	if err != nil {
		return bgv.Parameters{}, nil, err
	}
	key := rlwe.NewSecretKey(params)
	if err := key.UnmarshalBinary(secretBytes); err != nil {
		return bgv.Parameters{}, nil, fmt.Errorf("decode secret key: %w", err)
	}
	return params, key, nil
}

func decodeFHECiphertext(params bgv.Parameters, value string, claimedBytes int) (*rlwe.Ciphertext, error) {
	encoded, err := decodeFHEBase64(value, "ciphertext")
	if err != nil {
		return nil, err
	}
	if len(encoded) != claimedBytes {
		return nil, errors.New("ciphertext byte count does not match")
	}
	ciphertext := rlwe.NewCiphertext(params, 1, params.MaxLevel())
	if err := ciphertext.UnmarshalBinary(encoded); err != nil {
		return nil, fmt.Errorf("decode ciphertext: %w", err)
	}
	if ciphertext.Degree() != 1 || ciphertext.Level() != params.MaxLevel() {
		return nil, errors.New("ciphertext shape does not match the fixed FHE parameters")
	}
	return ciphertext, nil
}

func decodeFHEBase64(value, label string) ([]byte, error) {
	if value == "" || len(value) > base64.StdEncoding.EncodedLen(maxBinaryBytes) {
		return nil, fmt.Errorf("%s is empty or too large", label)
	}
	decoded, err := base64.StdEncoding.Strict().DecodeString(value)
	if err != nil || base64.StdEncoding.EncodeToString(decoded) != value {
		return nil, fmt.Errorf("invalid %s encoding", label)
	}
	if len(decoded) > maxBinaryBytes {
		return nil, fmt.Errorf("%s exceeds %d bytes", label, maxBinaryBytes)
	}
	return decoded, nil
}

func fheCommitment(domain, value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", errors.New("value must not be empty")
	}
	sum := sha256.Sum256([]byte(domain + "\x00" + value))
	return hex.EncodeToString(sum[:]), nil
}

func fheKeyID(publicKey []byte) string {
	sum := sha256.Sum256(append([]byte("skillgate:fhe-metrics:key:v1\x00"), publicKey...))
	return hex.EncodeToString(sum[:])
}

func isFHEHash(value string) bool {
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == sha256.Size && value == strings.ToLower(value)
}

func marshalFHE(value any) ([]byte, error) {
	return json.MarshalIndent(value, "", "  ")
}

func parseFHEPublicKey(data []byte) (publicKeyFile, error) {
	var value publicKeyFile
	return value, strictFHEJSON(data, &value)
}

func parseFHESecretKey(data []byte) (secretKeyFile, error) {
	var value secretKeyFile
	return value, strictFHEJSON(data, &value)
}

func parseEncryptedMetric(data []byte) (encryptedMetric, error) {
	var value encryptedMetric
	return value, strictFHEJSON(data, &value)
}

func parseEncryptedAggregate(data []byte) (encryptedAggregate, error) {
	var value encryptedAggregate
	return value, strictFHEJSON(data, &value)
}

func strictFHEJSON(data []byte, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return fmt.Errorf("decode JSON: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("decode JSON: multiple values are not allowed")
		}
		return fmt.Errorf("decode JSON: %w", err)
	}
	return nil
}
