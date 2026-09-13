public final class Main {
    public static void main(String[] args) {
        try {
            throw new IllegalStateException("bad");
        } catch (Exception error) {
            error.printStackTrace();
        }
    }
}
